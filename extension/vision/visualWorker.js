/**
 * Visual Worker — SIH26171 Phase 2
 *
 * Runs entirely off the main thread.
 * Spawned by the BACKGROUND SERVICE WORKER (not content scripts) so that
 * module workers and dynamic import() work under extension CSP.
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
 * relative to the screenshot image dimensions (matching the existing redactor.js
 * and detectionFusion.js conventions).
 *
 * The worker produces a sanitized screenshot as its primary output.
 * Raw pixels never leave the worker unsanitized.
 */

'use strict';

/* ── Worker-level state ── */
let mediapipeRuntime = null;      // { detector } or null
let mediapipeLoadPromise = null;  // single in-flight load
let workerReady = false;
let visualModelRuntime = null;    // future: general lightweight visual model

/* ── Visual model stub import (lazy) ─────────────────────────────────────────
 * The stub is a no-op until a real ONNX model artifact is integrated.
 * Import path is resolved at worker init time via the same extension origin.
 */
let _visualModelStubLoaded = false;
async function getVisualModelStub() {
  if (_visualModelStubLoaded) return self.SIH_VisualModelStub || null;
  try {
    // The stub sets self.SIH_VisualModelStub on load.
    // Dynamic import works in module workers under extension CSP.
    // Resolve URL relative to the extension origin (same as visualWorker.js).
    const stubUrl = new URL('./visualModelStub.js', import.meta.url).href;
    await import(stubUrl);
    _visualModelStubLoaded = true;
  } catch (e) {
    // Stub unavailable — continue without general visual model
    _visualModelStubLoaded = true; // mark as attempted so we don't retry
  }
  return self.SIH_VisualModelStub || null;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Message dispatch                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'PING':
      self.postMessage({ type: 'PONG', id: msg.id });
      return;

    case 'ANALYZE':
      await handleAnalyze(msg);
      return;

    default:
      // Unknown message — silently ignore
      return;
  }
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Main analysis pipeline                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

async function handleAnalyze(msg) {
  const { id, dataUrl, viewport, mediapipeWasmRoot, mediapipeModelPath, mediapipeBundleUrl } = msg;
  const timings = { workerReceiveMs: performance.now() };

  try {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('Invalid dataUrl received by visual worker');
    }

    // ── Step 1: Decode the screenshot into an ImageBitmap ──────────────────
    const decodeStart = performance.now();
    const blob = dataUrlToBlob(dataUrl);
    const imageBitmap = await createImageBitmap(blob);
    timings.decodeMs = performance.now() - decodeStart;

    const imgW = imageBitmap.width;
    const imgH = imageBitmap.height;

    postDiagnostic(id, 'screenshot', {
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
        const mpRuntime = await loadMediaPipe(mediapipeBundleUrl, mediapipeWasmRoot, mediapipeModelPath);
        if (mpRuntime) {
          cvAvailable = true;
          backend = 'WASM'; // MediaPipe Tasks Vision uses WASM in extensions

          // MediaPipe requires an ImageBitmap — recreate from canvas
          const bitmapForMp = await createImageBitmap(canvas);
          const rawDetections = mpRuntime.detect(bitmapForMp);
          bitmapForMp.close();

          faceDetections = normalizeMediaPipeResults(rawDetections, imgW, imgH);
        }
      } catch (err) {
        cvError = err.message;
        postDiagnostic(id, 'cv_error', { message: '[REDACTED_ERROR]', code: err.name });
      }
    }

    timings.cvMs = performance.now() - cvStart;

    postDiagnostic(id, 'cv_result', {
      backend,
      available: cvAvailable,
      faceCount: faceDetections.length,
      cvMs: timings.cvMs.toFixed(1),
      error: cvError ? 'ERROR_PRESENT' : null
    });

    // ── Step 3b: General visual model (stub — no-op until model is integrated) ──
    // When a real model is selected, replace visualModelStub.js.
    // The detection output merges into allDetections below.
    const cvGeneralStart = performance.now();
    let generalVisualDetections = [];
    try {
      const stub = await getVisualModelStub();
      if (stub && stub.isAvailable()) {
        // Real model path (future)
        const generalResult = await stub.runInference(canvas, { confidenceThreshold: 0.5 });
        if (generalResult?.available && Array.isArray(generalResult.detections)) {
          generalVisualDetections = generalResult.detections;
          postDiagnostic(id, 'general_visual_result', {
            available: true,
            count: generalVisualDetections.length,
            cvGeneralMs: (performance.now() - cvGeneralStart).toFixed(1)
          });
        }
      }
      // Stub always returns available=false — this branch is effectively a no-op in Phase 2
    } catch (_stubErr) {
      // Never let general visual model failure affect the main pipeline
    }
    timings.cvGeneralMs = performance.now() - cvGeneralStart;

    const sanitizeStart = performance.now();
    const allDetections = [...faceDetections, ...generalVisualDetections];

    // Also include any text PII rects passed in from the content script
    // (already in viewport-relative coords from DOM/regex detectors).
    const inboundRects = Array.isArray(msg.rects) ? msg.rects : [];
    for (const rect of inboundRects) {
      if (rect && rect.type && typeof rect.x === 'number') {
        allDetections.push({ ...rect, source: rect.source || 'dom_passthrough' });
      }
    }

    applyRedaction(ctx, canvas.width, canvas.height, allDetections, viewport);
    timings.sanitizeMs = performance.now() - sanitizeStart;

    // ── Step 5: Export sanitized screenshot ────────────────────────────────
    const exportStart = performance.now();
    const sanitizedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const sanitizedDataUrl = await blobToDataUrl(sanitizedBlob);
    timings.exportMs = performance.now() - exportStart;

    timings.totalMs = performance.now() - timings.workerReceiveMs;

    postDiagnostic(id, 'sanitized_screenshot', {
      viewport: `${imgW}x${imgH}`,
      totalDetections: allDetections.length,
      sanitizedRegions: allDetections.filter(d => d.rect || (typeof d.x === 'number')).length,
      totalMs: timings.totalMs.toFixed(1)
    });

    self.postMessage({
      type: 'RESULT',
      id,
      detections: allDetections,
      sanitizedDataUrl,
      backend,
      timings
    });

  } catch (err) {
    // Fail-closed: never return the raw screenshot if sanitization failed
    self.postMessage({
      type: 'RESULT',
      id,
      detections: [],
      sanitizedDataUrl: null, // BLOCKED — sanitization failed
      backend: 'unavailable',
      timings,
      error: err.message
    });
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
      // Emit diagnostic but do NOT fall back to importScripts (it breaks .mjs)
      self.postMessage({
        type: 'DIAGNOSTIC',
        id: 'mediapipe_load',
        stage: 'mediapipe_import_failed',
        data: { name: importErr.name, bundleUrl }
      });
      console.warn('[SIH][Worker] MediaPipe dynamic import() failed:', importErr.name, importErr.message);
    }

    if (!vision || !vision.FilesetResolver || !vision.FaceDetector) {
      console.warn('[SIH][Worker] MediaPipe API unavailable after import — face detection disabled, text PII masking remains active');
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

function postDiagnostic(id, stage, data) {
  // Never include raw pixel data or PII values in diagnostics
  self.postMessage({ type: 'DIAGNOSTIC', id, stage, data });
}
