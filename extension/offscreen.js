/**
 * Offscreen Document Controller — SIH26171 Phase 2 Architecture
 *
 * MV3 Architectural Role:
 *   Chrome MV3 extension service workers cannot call `new Worker()`.
 *   The offscreen document exists exclusively with reason ['WORKERS']
 *   to own the dedicated visual worker (`visualWorker.js`) under the extension's
 *   origin, allowing module workers and dynamic import() of MediaPipe vision_bundle.mjs.
 *
 * This script is intentionally minimal:
 * - Owns the dedicated visual Web Worker
 * - Handles worker lifecycle (creation, error recovery, messaging)
 * - Listens for OFFSCREEN_ANALYZE messages from background.js
 * - Returns sanitized screenshot + detections (fail-closed)
 */

'use strict';

let visualWorker = null;
let visualWorkerReady = false;
const pendingRequests = new Map();
let requestCounter = 0;
const WORKER_TIMEOUT_MS = 60000;

function getWorkerUrl() {
  try {
    return chrome.runtime.getURL('vision/visualWorker.js');
  } catch (e) {
    return null;
  }
}

function ensureWorker() {
  if (visualWorker && visualWorkerReady) return true;

  const url = getWorkerUrl();
  if (!url) {
    console.warn('[SIH][Offscreen] Cannot resolve visualWorker URL');
    return false;
  }

  try {
    visualWorker = new Worker(url, { type: 'module' });
    visualWorker.onmessage = handleWorkerMessage;
    visualWorker.onerror = handleWorkerError;
    visualWorkerReady = true;
    console.info('[SIH][Offscreen] Dedicated visual worker spawned successfully:', url);
    return true;
  } catch (err) {
    console.error('[SIH][Offscreen] Failed to spawn module worker:', err.message);
    visualWorker = null;
    visualWorkerReady = false;
    return false;
  }
}

function handleWorkerMessage(event) {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'DIAGNOSTIC') {
    // Forward diagnostic back to background / caller tab
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_DIAGNOSTIC',
      requestId: msg.id,
      stage: msg.stage,
      data: msg.data
    }).catch(() => {});
    return;
  }

  const pending = pendingRequests.get(msg.id);
  if (!pending) return;

  clearTimeout(pending.timeout);
  pendingRequests.delete(msg.id);

  if (msg.type === 'RESULT') {
    pending.resolve(msg);
  } else {
    pending.reject(new Error(`Unexpected worker message type: ${msg.type}`));
  }
}

function handleWorkerError(err) {
  console.error('[SIH][Offscreen] Dedicated visual worker error:', err?.message || err);
  // Fail-closed: reject all pending requests without leaking data
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Visual worker crashed in offscreen document'));
  }
  pendingRequests.clear();
  visualWorker = null;
  visualWorkerReady = false;
}

/**
 * Execute visual analysis on offscreen dedicated worker.
 */
function analyzeInWorker(message) {
  if (!ensureWorker()) {
    return Promise.resolve({
      detections: [],
      sanitizedDataUrl: null,
      backend: 'unavailable',
      timings: {},
      error: 'Offscreen visual worker unavailable'
    });
  }

  const id = `offscreen_req_${++requestCounter}_${Date.now()}`;
  const mediapipeWasmRoot = chrome.runtime.getURL('vendor/mediapipe/wasm');
  const mediapipeModelPath = chrome.runtime.getURL('vendor/mediapipe/models/blaze_face_short_range.tflite');
  const mediapipeBundleUrl = chrome.runtime.getURL('vendor/mediapipe/vision_bundle.mjs');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Offscreen visual worker timed out'));
    }, WORKER_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timeout });

    visualWorker.postMessage({
      type: 'ANALYZE',
      id,
      dataUrl: message.dataUrl,
      viewport: message.viewport,
      rects: message.safeRects || [],
      mediapipeWasmRoot,
      mediapipeModelPath,
      mediapipeBundleUrl
    });
  });
}

// ── Message Listener ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'OFFSCREEN') return false;

  switch (message.type) {
    case 'OFFSCREEN_PING':
      sendResponse({ ok: true, ready: visualWorkerReady });
      return false;

    case 'OFFSCREEN_ANALYZE': {
      analyzeInWorker(message)
        .then((result) => {
          sendResponse({
            ok: true,
            result
          });
        })
        .catch((err) => {
          // Fail-closed: never return unsanitized screenshot
          sendResponse({
            ok: false,
            result: {
              detections: [],
              sanitizedDataUrl: null,
              backend: 'unavailable',
              error: err.message
            }
          });
        });
      return true; // async sendResponse
    }

    default:
      return false;
  }
});

// Eagerly initialize worker on offscreen document boot
ensureWorker();
