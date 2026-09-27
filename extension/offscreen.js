/**
 * Offscreen Document Controller — SIH26171 Phase 2 Architecture
 *
 * Runs entirely in the offscreen document to process visual tasks,
 * avoiding the need for a Dedicated Worker because the Offscreen Document
 * is already an isolated background context that doesn't block the main thread.
 *
 * This script:
 * - Listens for OFFSCREEN_ANALYZE messages from background.js
 * - Runs visualWorker.js logic (MediaPipe Face Detection) natively
 * - Returns sanitized screenshot + detections (fail-closed)
 */

'use strict';

import { handleAnalyze } from './vision/visualWorker.js';

let requestCounter = 0;

/**
 * Execute visual analysis natively in the offscreen document.
 */
async function analyzeNative(message) {
  const id = `offscreen_req_${++requestCounter}_${Date.now()}`;
  const mediapipeWasmRoot = chrome.runtime.getURL('vendor/mediapipe/wasm/');
  const mediapipeModelPath = chrome.runtime.getURL('vendor/mediapipe/models/blaze_face_short_range.tflite');
  const mediapipeBundleUrl = chrome.runtime.getURL('vendor/mediapipe/vision_bundle.mjs');
  const tesseractRoot = chrome.runtime.getURL('vendor/tesseract/');

  const workerMsg = {
    id,
    dataUrl: message.dataUrl,
    viewport: message.viewport,
    rects: message.safeRects || [],
    mediapipeWasmRoot,
    mediapipeModelPath,
    mediapipeBundleUrl,
    tesseractRoot
  };

  const requestDiagnostic = (reqId, stage, data) => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_DIAGNOSTIC',
      requestId: reqId,
      stage: stage,
      data: data,
      tabId: message.tabId,
      generation: message.generation
    }).catch(() => {});
  };

  try {
    const result = await handleAnalyze(workerMsg, requestDiagnostic);
    if (!result || !result.ok || !result.sanitizedDataUrl || result.backend === 'unavailable') {
      return {
        ok: false,
        detections: [],
        sanitizedDataUrl: null,
        discarded: true,
        backend: 'unavailable',
        cvExecuted: false,
        ocrExecuted: false,
        ocrAvailable: false,
        ocrText: '',
        timings: result?.timings || {},
        error: result?.error || 'CV_UNAVAILABLE'
      };
    }
    return result;
  } catch (err) {
    console.error('[SIH][Offscreen] Visual analysis crashed:', err.message);
    return {
      ok: false,
      detections: [],
      sanitizedDataUrl: null,
      discarded: true,
      backend: 'unavailable',
      cvExecuted: false,
      ocrExecuted: false,
      ocrAvailable: false,
      ocrText: '',
      timings: {},
      error: err.message || 'CV_UNAVAILABLE'
    };
  } finally {
    message.dataUrl = null;
    workerMsg.dataUrl = null;
  }
}

// ── Message Listener ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'OFFSCREEN') return false;

  switch (message.type) {
    case 'OFFSCREEN_PING':
      sendResponse({ ok: true, ready: true });
      return false;

    case 'OFFSCREEN_ANALYZE': {
      console.info(`[SIH][OFFSCREEN 01] VISUAL_ANALYZE received`);
      console.info(`[SIH][VISION TRACE 8]\nOFFSCREEN_ANALYZE received\nkeys=${Object.keys(message).join(',')}`);
      analyzeNative(message)
        .then((result) => {
          console.info('[SIH][VISION] offscreen response ready');
          sendResponse({
            ok: Boolean(result?.ok && result?.sanitizedDataUrl),
            result
          });
        })
        .catch((err) => {
          console.error(`[SIH][OFFSCREEN ERROR]\nerror.name=${err.name}\nerror.message=${err.message}\nstack=${err.stack}`);
          sendResponse({
            ok: false,
            result: {
              ok: false,
              detections: [],
              sanitizedDataUrl: null,
              discarded: true,
              backend: 'unavailable',
              cvExecuted: false,
              ocrExecuted: false,
              error: err.message || 'OFFSCREEN_ERROR'
            }
          });
        })
        .finally(() => {
          if (message) message.dataUrl = null;
        });
      return true; // async sendResponse
    }

    default:
      return false;
  }
});

console.info('[SIH][VISION] offscreen ready (native mode)');
