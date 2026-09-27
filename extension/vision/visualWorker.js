/**
 * Offscreen Visual Processor — SIH26171
 *
 * Runs inside the minimal Offscreen Document (offscreen.html) as an ES module.
 * Executes MediaPipe face detection and screenshot redaction off the main thread.
 *
 * Message protocol (all messages carry a { id } for correlation):
 *
 *   Inbound:
 *     { type: 'ANALYZE', id, dataUrl, viewport, rects,
 *       mediapipeWasmRoot, mediapipeModelPath, mediapipeBundleUrl }
 *     { type: 'PING', id }
 *
 *   Outbound:
 *     { type: 'RESULT', id, detections, sanitizedDataUrl, backend, timings, error }
 *     { type: 'PONG', id }
 *     { type: 'DIAGNOSTIC', id, stage, data }
 *
 * Coordinate convention: ALL bounding boxes use ABSOLUTE PIXEL coordinates
 * relative to the screenshot image dimensions.
 *
 * The processor produces a sanitized screenshot as its primary output.
 * Raw pixels never leave the offscreen document unsanitized.
 */

'use strict';

/* ── Processor-level state ── */
let mediapipeRuntime = null;      // { detector } or null
let mediapipeLoadPromise = null;  // single in-flight load

/* ── OCR Runtime State (Delegated to authoritative SIH_OcrDetector backed by local vendor/tesseract/) ── */
function getOcrDetector() {
  if (typeof self !== 'undefined' && self.SIH_OcrDetector) {
    return self.SIH_OcrDetector;
  }
  return null;
}

/**
 * Sanitize extracted OCR text before it enters model context.
 * Bounded length, normalized whitespace, stripped control characters,
 * and secondary PII regex scrubbing.
 */
export function sanitizeOcrText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let clean = rawText;
  clean = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  clean = clean.replace(/[ \t]{2,}/g, ' ');
  clean = clean.replace(/\n{3,}/g, '\n\n');
  clean = clean.split('\n').map(line => line.trim()).join('\n').trim();

  // Enforce bounding limit (max 2000 characters)
  const MAX_OCR_LENGTH = 2000;
  if (clean.length > MAX_OCR_LENGTH) {
    clean = clean.slice(0, MAX_OCR_LENGTH).trim() + '...';
  }

  // Secondary safety regex pass for any missed standard PII
  clean = clean.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  clean = clean.replace(/(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/g, '[REDACTED_PHONE]');
  clean = clean.replace(/\b(?:\d[\s\-]?){13,19}\b/g, '[REDACTED_NUMBER]');

  return clean;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main analysis pipeline                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

export async function handleAnalyze(msg, onDiagnosticCallback) {
  console.info('[SIH][VISION] visual processor started');
  const { id, dataUrl, viewport, mediapipeWasmRoot, mediapipeModelPath, mediapipeBundleUrl } = msg;
  const timings = { workerReceiveMs: performance.now() };

  // Request-scoped diagnostic emitter — avoids concurrency hazards
  const postDiagnostic = (stage, data) => {
    if (typeof onDiagnosticCallback === 'function') {
      onDiagnosticCallback(id, stage, data);
    }
  };

  try {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('Invalid dataUrl received by visual worker');
    }

    // ── Step 1: Decode the screenshot into an ImageBitmap ──────────────────
    console.info(`[SIH][OFFSCREEN 02] image decode started`);
    const decodeStart = performance.now();
    const blob = dataUrlToBlob(dataUrl);
    msg.dataUrl = null; // Discard raw screenshot reference immediately after decoding
    const imageBitmap = await createImageBitmap(blob);
    console.info(`[SIH][OFFSCREEN 03] image decode completed`);
    timings.decodeMs = performance.now() - decodeStart;

    const imgW = imageBitmap.width;
    const imgH = imageBitmap.height;

    postDiagnostic('screenshot', {
      imageWidth: imgW,
      imageHeight: imgH,
      viewportWidth: viewport?.width,
      viewportHeight: viewport?.height
    });

    // ── Step 2: Draw image to OffscreenCanvas ──────────────────────────────
    const canvas = new OffscreenCanvas(imgW, imgH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0);
    imageBitmap.close(); // free memory

    // ── Step 3: MediaPipe face detection ───────────────────────────────────
    const cvStart = performance.now();
    let faceDetections = [];
    let cvAvailable = false;
    let cvError = null;
    let backend = 'unavailable';

    if (mediapipeWasmRoot && mediapipeModelPath && mediapipeBundleUrl) {
      try {
        console.info(`[SIH][MP 01] runtime initialization started`);
        console.info('[SIH][VISION] MediaPipe initialization started');
        const mpRuntime = await loadMediaPipe(mediapipeBundleUrl, mediapipeWasmRoot, mediapipeModelPath);
        if (mpRuntime) {
          console.info(`[SIH][MP 02] runtime available`);
          console.info(`[SIH][MP 03] detector initialization started`);
          console.info(`[SIH][MP 04] detector initialized`);
          console.info('[SIH][VISION] MediaPipe initialization completed');
          cvAvailable = true;
          backend = 'mediapipe';

          // MediaPipe requires an ImageBitmap — recreate from canvas
          console.info(`[SIH][OFFSCREEN 04] visual worker/detector started`);
          console.info(`[SIH][MP 05] inference started`);
          console.info(`[SIH][VISION TRACE 11]\ninference started\nbackend=${backend}`);
          const bitmapForMp = await createImageBitmap(canvas);
          const rawDetections = mpRuntime.detect(bitmapForMp);
          bitmapForMp.close();

          console.info(`[SIH][MP 06] inference completed`);
          faceDetections = normalizeMediaPipeResults(rawDetections, imgW, imgH);
          console.info(`[SIH][MP 07] faces detected=${faceDetections.length}`);
          console.info(`[SIH][OFFSCREEN 05] detector completed`);
          console.info(`[SIH][VISION TRACE 12]\ninference completed\nfacesDetected=${faceDetections.length}`);
        }
      } catch (err) {
        console.error(`[SIH][MP ERROR]\nerror.name=${err.name}\nerror.message=${err.message}\nstack=${err.stack}`);
        cvError = err.message;
        postDiagnostic('cv_error', { message: '[REDACTED_ERROR]', code: err.name });
      }
    }

    timings.cvMs = performance.now() - cvStart;

    postDiagnostic('cv_result', {
      backend,
      available: cvAvailable,
      faceCount: faceDetections.length,
      cvMs: timings.cvMs.toFixed(1),
      error: cvError ? 'ERROR_PRESENT' : null
    });

    // FAIL-CLOSED INVARIANT: If CV backend is unavailable or failed, do NOT return screenshot
    if (!cvAvailable || cvError || backend === 'unavailable') {
      return {
        ok: false,
        sanitizedDataUrl: null,
        detections: [],
        discarded: true,
        backend: 'unavailable',
        cvExecuted: false,
        ocrExecuted: false,
        timings,
        error: cvError || 'CV_UNAVAILABLE'
      };
    }

    // ── Step 4: Redact sensitive regions on OffscreenCanvas ───────────────
    const sanitizeStart = performance.now();
    const allDetections = [...faceDetections];

    // Also include any text PII rects passed in from the content script
    // (already in viewport-relative coords from DOM/regex detectors).
    const inboundRects = Array.isArray(msg.rects) ? msg.rects : [];
    for (const rect of inboundRects) {
      if (rect && rect.type && typeof rect.x === 'number') {
        allDetections.push({ ...rect, source: rect.source || 'dom_passthrough' });
      }
    }

    console.info(`[SIH][OFFSCREEN 06] redaction started`);
    console.info(`[SIH][VISION TRACE 13]\nredaction started\nregions=${allDetections.length}`);
    applyRedaction(ctx, canvas.width, canvas.height, allDetections, viewport);
    console.info(`[SIH][MP 08] redaction completed`);
    console.info(`[SIH][OFFSCREEN 07] redaction completed`);
    console.info(`[SIH][VISION TRACE 14]\nredaction completed\nfacesMasked=${faceDetections.length}`);
    timings.sanitizeMs = performance.now() - sanitizeStart;

    // ── Step 5: Local OCR execution on sanitized canvas ────────────────────
    // CRITICAL: Executes strictly on the sanitized (redacted) canvas
    // so any visual PII (faces, text PII) has already been masked.
    const ocrStart = performance.now();
    let ocrExecuted = false;
    let ocrAvailable = false;
    let ocrText = '';
    let ocrError = null;

    try {
      const detector = getOcrDetector();
      if (detector && detector.isAvailable()) {
        ocrAvailable = true;
        // 6s timeout to prevent hanging
        const ocrPromise = detector.recognize(canvas, { root: msg.tesseractRoot });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OCR_TIMEOUT')), 6000)
        );
        const ocrResult = await Promise.race([ocrPromise, timeoutPromise]);
        if (ocrResult && ocrResult.available) {
          const extracted = ocrResult.text || '';
          ocrText = sanitizeOcrText(extracted);
          ocrExecuted = true;
        } else if (ocrResult && !ocrResult.available) {
          ocrError = ocrResult.reason || 'OCR_UNAVAILABLE';
        }
      }
    } catch (err) {
      console.warn('[SIH][OCR] Local OCR failed safely:', err.message);
      ocrError = err.message;
      ocrExecuted = false;
      ocrText = '';
    }

    timings.ocrMs = performance.now() - ocrStart;

    postDiagnostic('ocr_result', {
      executed: ocrExecuted,
      available: ocrAvailable,
      ocrMs: timings.ocrMs.toFixed(1),
      chars: ocrText.length,
      error: ocrError ? 'ERROR_PRESENT' : null
    });

    // ── Step 6: Export sanitized screenshot ────────────────────────────────
    const exportStart = performance.now();
    const sanitizedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const sanitizedDataUrl = await blobToDataUrl(sanitizedBlob);
    console.info(`[SIH][OFFSCREEN 08] sanitized result generated`);
    timings.exportMs = performance.now() - exportStart;

    timings.totalMs = performance.now() - timings.workerReceiveMs;

    postDiagnostic('sanitized_screenshot', {
      viewport: `${imgW}x${imgH}`,
      totalDetections: allDetections.length,
      sanitizedRegions: allDetections.filter(d => d.rect || (typeof d.x === 'number')).length,
      totalMs: timings.totalMs.toFixed(1)
    });

    return {
      ok: true,
      sanitizedDataUrl,
      detections: allDetections,
      discarded: false,
      backend: 'mediapipe',
      cvExecuted: true,
      ocrExecuted,
      ocrAvailable,
      ocrText,
      ocrDebug: ocrError || null,
      timings,
      error: null
    };

  } catch (err) {
    // Fail-closed: never return the raw screenshot if sanitization or pipeline failed
    return {
      ok: false,
      sanitizedDataUrl: null, // BLOCKED — sanitization failed
      detections: [],
      discarded: true,
      backend: 'unavailable',
      cvExecuted: false,
      ocrExecuted: false,
      ocrAvailable: false,
      ocrText: '',
      timings,
      error: err.message || 'VISUAL_WORKER_ERROR'
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Redaction — in-place canvas operations                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Apply sanitization operations to the OffscreenCanvas context.
 *
 * FACE → pixel-level blur via repeated downscale/upscale (fail → solid mask)
 * TEXT PII → solid opaque rectangle
 *
 * COORDINATE SYSTEM:
 *   - MediaPipe detections (source === 'mediapipe'): absolute image-pixel coords
 *   - DOM/Regex rects (passthrough): viewport-relative CSS pixel coords
 *     (captureVisibleTab captures the viewport, so viewport coords map
 *      1:1 at DPR=1; at HiDPI/DPR>1 we scale by imgW/viewportWidth)
 */
function applyRedaction(ctx, imgW, imgH, detections, viewport) {
  // Scale from viewport CSS pixels → screenshot image pixels
  // captureVisibleTab returns an image at device pixel ratio resolution
  const scaleX = viewport && viewport.width > 0 ? imgW / viewport.width : 1;
  const scaleY = viewport && viewport.height > 0 ? imgH / viewport.height : 1;

  for (const detection of detections) {
    // Resolve bounding box — prefer rect, fall back to bbox, fall back to x/y/w/h root
    const raw = detection.rect || detection.bbox || detection;
    if (!raw || typeof raw.x !== 'number' || typeof raw.y !== 'number') continue;

    // Determine coordinate origin:
    //   mediapipe/vision → already in image-pixel space (absolute px in screenshot)
    //   dom_passthrough  → viewport CSS coords → need to scale by DPR factor
    const fromWorker = detection.source === 'mediapipe' || detection.source === 'vision';
    const sx = fromWorker ? 1 : scaleX;
    const sy = fromWorker ? 1 : scaleY;

    const x = Math.max(0, raw.x * sx);
    const y = Math.max(0, raw.y * sy);
    const w = Math.min(imgW - x, (raw.width || 0) * sx);
    const h = Math.min(imgH - y, (raw.height || 0) * sy);

    if (w <= 0 || h <= 0) continue;

    const type = (detection.type || '').toLowerCase();

    if (type === 'face') {
      // ── Face: blur (with solid-mask fallback) ────────────────────────────
      try {
        applyCanvasBlur(ctx, x, y, w, h);
      } catch (_) {
        // Fallback: solid mask — never leave the face visible
        ctx.fillStyle = '#111827';
        ctx.fillRect(x, y, w, h);
      }
    } else {
      // ── Text PII: solid mask ──────────────────────────────────────────────
      ctx.fillStyle = '#111827';
      ctx.fillRect(x, y, w, h);
    }
  }
}

/**
 * Canvas-based pixelation blur.
 * Technique: downscale region → upscale → bilinear interpolation = blur.
 */
function applyCanvasBlur(ctx, x, y, w, h) {
  const BLUR_FACTOR = 10; // larger = more blurred / more pixelated
  const sw = Math.max(1, Math.round(w / BLUR_FACTOR));
  const sh = Math.max(1, Math.round(h / BLUR_FACTOR));

  // Copy source region at original size
  const sourceCanvas = new OffscreenCanvas(w, h);
  const sCtx = sourceCanvas.getContext('2d');
  sCtx.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);

  // Downscale (creates blocky version)
  const tinyCanvas = new OffscreenCanvas(sw, sh);
  const tCtx = tinyCanvas.getContext('2d');
  tCtx.imageSmoothingEnabled = false; // nearest-neighbour downscale
  tCtx.drawImage(sourceCanvas, 0, 0, w, h, 0, 0, sw, sh);

  // Upscale back — bilinear interpolation produces the blur
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(tinyCanvas, 0, 0, sw, sh, x, y, w, h);
  ctx.restore();
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* MediaPipe runtime                                                           */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Load MediaPipe Tasks Vision face detector.
 *
 * CRITICAL FIX: Only uses dynamic import() (ES module path).
 * The broken importScripts() fallback has been removed because:
 *   1. importScripts() cannot load ES module (.mjs) files — MIME type mismatch.
 *   2. This worker is now spawned from the service worker which has
 *      extension CSP, so dynamic import() of extension-origin URLs works.
 *
 * @param {string} bundleUrl  chrome-extension://...vendor/mediapipe/vision_bundle.mjs
 * @param {string} wasmRoot   chrome-extension://...vendor/mediapipe/wasm
 * @param {string} modelPath  chrome-extension://...vendor/mediapipe/models/blaze_face...
 */
async function loadMediaPipe(bundleUrl, wasmRoot, modelPath) {
  if (mediapipeRuntime) return mediapipeRuntime;
  if (mediapipeLoadPromise) return mediapipeLoadPromise;

  mediapipeLoadPromise = (async () => {
    let vision = null;

    // Dynamic import() — works in module workers under extension CSP
    try {
      vision = await import(bundleUrl);
    } catch (importErr) {
      console.warn('[SIH][Worker] MediaPipe dynamic import() failed:', importErr.name, importErr.message);
    }

    if (!vision || !vision.FilesetResolver || !vision.FaceDetector) {
      console.warn('[SIH][Worker] MediaPipe API unavailable after import — face detection disabled');
      mediapipeLoadPromise = null;
      return null;
    }

    try {
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmRoot);
      const detector = await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.4  // slightly lower threshold for test fixtures
      });

      mediapipeRuntime = {
        detect(image) {
          const result = detector.detect(image);
          return result.detections || [];
        }
      };
      console.info('[SIH][Worker] MediaPipe FaceDetector initialized successfully (WASM backend)');
      return mediapipeRuntime;

    } catch (err) {
      console.warn('[SIH][Worker] MediaPipe FaceDetector init failed:', err.name, err.message);
      if (typeof onDiagnosticGlobal !== 'undefined' && onDiagnosticGlobal) {
        onDiagnosticGlobal('mediapipe_load', 'cv_error', { name: err.name, code: err.message });
      }
      mediapipeRuntime = null;
      mediapipeLoadPromise = null;
      return null;
    }
  })();

  return mediapipeLoadPromise;
}

/**
 * Convert raw MediaPipe detection results to the project's Detection shape.
 * Outputs absolute pixel coordinates within the screenshot image.
 */
function normalizeMediaPipeResults(rawDetections, imgW, imgH) {
  if (!Array.isArray(rawDetections)) return [];
  return rawDetections.map((det, index) => {
    const box = det.boundingBox || {};
    const x = Math.max(0, box.originX || 0);
    const y = Math.max(0, box.originY || 0);
    const w = Math.min(imgW - x, box.width || 0);
    const h = Math.min(imgH - y, box.height || 0);
    const confidence = det.categories?.[0]?.score ?? 0;
    return {
      id: `face_${index + 1}`,
      type: 'face',
      source: 'mediapipe',
      confidence: Math.min(1, Math.max(0, confidence)),
      // Absolute pixel coords in screenshot space (already image-pixel units from MediaPipe)
      x, y, width: w, height: h,
      rect: { x, y, width: w, height: h },
      bbox: { x, y, width: w, height: h }
    };
  });
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Utility                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Worker: Failed to export sanitized image'));
    reader.readAsDataURL(blob);
  });
}
