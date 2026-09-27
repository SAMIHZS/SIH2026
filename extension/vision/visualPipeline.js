/**
 * Visual Pipeline Controller — SIH26171 Phase 2
 *
 * Main-thread controller for the off-thread visual worker.
 *
 * ARCHITECTURE CHANGE (Phase 2 stabilization):
 *   The visual worker is now OWNED BY THE BACKGROUND SERVICE WORKER, not by
 *   the content script.  Content scripts run under the host page's CSP, which
 *   prevents module workers and dynamic import() of vision_bundle.mjs.
 *   The service worker runs under the extension's own CSP where this works.
 *
 *   This module now delegates analysis via the VISUAL_ANALYZE message to the
 *   background service worker, which handles capture + worker + result.
 *
 * Public API (unchanged from the old interface):
 *   isAvailable()  → boolean
 *   analyze(dataUrl, viewport, existingRects) → Promise<{sanitizedDataUrl, detections, backend, timings}>
 *   logProviderPayloadDiagnostic(options)
 *
 * The analyze() method no longer accepts a raw dataUrl — instead it sends
 * the viewport/rect info to the background which captures and processes
 * atomically. This avoids TOCTOU races between capture and analysis.
 *
 * Coordinate convention: bounding boxes from the worker are in absolute
 * pixel coordinates within the screenshot image, matching the existing
 * detectionFusion.js and redactor.js conventions.
 *
 * This module is injected as a content-script via manifest.json and exposes
 * window.SIH_VisualPipeline.
 */
(function() {
  'use strict';

  const REQUEST_TIMEOUT_MS = 10000; // 10s timeout to fail-safe visual pipeline

  /* ── Check availability ────────────────────────────────────────────────── */
  function isAvailable() {
    // Available if we are in a content script with chrome.runtime messaging
    return typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function';
  }

  /* ── Structured diagnostic output ─────────────────────────────────────── */
  function handleWorkerDiagnostic(stage, data) {
    switch (stage) {
      case 'screenshot':
        console.groupCollapsed('[SIH][Visual] Screenshot received by worker');
        console.info('Image:', `${data.imageWidth}×${data.imageHeight}`);
        console.info('Viewport:', `${data.viewportWidth}×${data.viewportHeight}`);
        console.groupEnd();
        break;
      case 'cv_result':
        console.groupCollapsed('[SIH][Visual] CV result');
        console.info('Backend:', data.backend);
        console.info('Available:', data.available);
        console.info('Faces detected:', data.faceCount);
        console.info('CV time:', `${data.cvMs}ms`);
        if (data.error) console.warn('CV error present (details redacted)');
        console.groupEnd();
        break;
      case 'sanitized_screenshot':
        console.groupCollapsed('[SIH][Visual] Screenshot sanitized');
        console.info('Viewport:', data.viewport);
        console.info('Total detections:', data.totalDetections);
        console.info('Sanitized regions:', data.sanitizedRegions);
        console.info('Total time:', `${data.totalMs}ms`);
        console.groupEnd();
        break;
      case 'cv_error':
      case 'mediapipe_import_failed':
        console.warn('[SIH][Visual] CV/MediaPipe error —', data.code || data.name, '| URL:', data.bundleUrl || '');
        break;
      default:
        break;
    }
  }

  /* ── Core public API ──────────────────────────────────────────────────── */

  /**
   * Delegate visual analysis to the background service worker.
   *
   * The old signature accepted (dataUrl, viewport, existingRects).
   * The new signature ignores dataUrl (background captures it) and uses
   * (_, viewport, existingRects) for backwards compatibility with content.js
   * which may still pass a dataUrl — we just ignore it since background will
   * capture a fresh screenshot atomically with the analysis.
   *
   * @param {string|null} _dataUrl      IGNORED — background captures fresh
   * @param {object}      viewport      { width, height, scrollX, scrollY }
   * @param {Array}       existingRects geometry-only rects from DOM/Regex
   * @param {number}      generation    analysis generation token for stale protection
   * @returns {Promise<{
   *   sanitizedDataUrl: string|null,
   *   detections: Array,
   *   backend: string,
   *   timings: object
   * }>}
   */
  function analyze(_dataUrl, viewport, existingRects, generation) {
    if (!isAvailable()) {
      return Promise.resolve({
        ok: false,
        sanitizedDataUrl: null,
        detections: [],
        discarded: true,
        backend: 'unavailable',
        cvExecuted: false,
        ocrExecuted: false,
        timings: {},
        error: 'Visual pipeline not available'
      });
    }

    // Sanitize rects: strip raw values, keep only geometry + type
    const safeRects = (Array.isArray(existingRects) ? existingRects : [])
      .filter(r => r && typeof r.x === 'number')
      .map(r => ({
        type: r.type || 'sensitive',
        source: r.source || 'unknown',
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        confidence: r.confidence
        // NOTE: raw 'value' field intentionally EXCLUDED
      }));

    return new Promise((resolve, reject) => {
      // Safety timeout in case background never responds
      const timer = setTimeout(() => {
        reject(new Error('VISUAL_ANALYZE: background did not respond within timeout'));
      }, REQUEST_TIMEOUT_MS);

      console.info(`[SIH][VISION TRACE 1]\nsending VISUAL_ANALYZE\ngeneration=${generation || 0}\ntype=VISUAL_ANALYZE\nhasScreenshot=false`);

      chrome.runtime.sendMessage({
        type: 'VISUAL_ANALYZE',
        viewport: viewport || { width: window.innerWidth, height: window.innerHeight },
        safeRects,
        generation: generation || 0
      }, (response) => {
        clearTimeout(timer);
        console.info(`[SIH][VISION TRACE 2]\nVISUAL_ANALYZE response received\nresponse exists = ${!!response}\nresponse keys = ${response ? Object.keys(response).join(',') : 'null'}`);

        console.info('[SIH][VISUAL RESULT]', {
          success: Boolean(response?.sanitizedDataUrl),
          backend: response?.backend || 'unknown',
          detectionCount: Array.isArray(response?.detections) ? response.detections.length : 0,
          discarded: Boolean(response?.discarded),
          error: response?.error || null
        });
        if (chrome.runtime.lastError) {
          console.error(`[SIH][VISION ERROR]\nstage=VISUAL_ANALYZE\nmessage=${chrome.runtime.lastError.message}`);
          // Background unavailable — fail gracefully
          resolve({
            ok: false,
            sanitizedDataUrl: null,
            detections: [],
            discarded: true,
            backend: 'unavailable',
            cvExecuted: false,
            ocrExecuted: false,
            timings: {},
            error: chrome.runtime.lastError.message
          });
          return;
        }
        if (!response) {
          resolve({
            ok: false,
            sanitizedDataUrl: null,
            detections: [],
            discarded: true,
            backend: 'unavailable',
            cvExecuted: false,
            ocrExecuted: false,
            timings: {},
            error: 'No response from background'
          });
          return;
        }
        if (response.error || !response.sanitizedDataUrl || response.backend === 'unavailable' || !response.ok) {
          // Worker/capture error — fail-closed (no screenshot returned)
          resolve({
            ok: false,
            sanitizedDataUrl: null,
            detections: response.detections || [],
            discarded: Boolean(response.discarded),
            backend: 'unavailable',
            cvExecuted: Boolean(response.cvExecuted),
            ocrExecuted: false,
            timings: response.timings || {},
            error: response.error || 'CV_UNAVAILABLE'
          });
          return;
        }
        resolve(response);
      });
    });
  }

  /**
   * Emit provider-payload diagnostics (no raw data).
   */
  function logProviderPayloadDiagnostic(options) {
    console.groupCollapsed('[SIH][PROVIDER REQUEST]');
    console.info('Text Context:', options.hasText ? 'PRESENT' : 'ABSENT');
    console.info('Screenshot:', options.hasScreenshot ? 'PRESENT' : 'NOT PRESENT');
    if (options.hasScreenshot) {
      console.info('Screenshot Sanitized:', options.isSanitized ? 'TRUE' : 'FALSE');
      console.info('Screenshot Bytes:', options.screenshotBytes ?? 'unknown');
    }
    console.info('Provider:', options.provider || 'unknown');
    console.info('Model:', options.model || 'unknown');
    console.info('Screenshot Sharing:', options.sharingEnabled ? 'ON' : 'OFF');
    console.info('Transmission:', options.willTransmit ? 'ALLOWED' : 'BLOCKED');
    console.groupEnd();
  }

  /* ── Expose ─────────────────────────────────────────────────────────── */
  if (typeof window !== 'undefined') {
    window.SIH_VisualPipeline = {
      isAvailable,
      analyze,
      logProviderPayloadDiagnostic,
      handleWorkerDiagnostic  // exposed for VISUAL_DIAGNOSTIC message handler in content.js
    };
  }
})();
