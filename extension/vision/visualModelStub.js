/**
 * Visual Model Stub — SIH26171
 *
 * ARCHITECTURAL PLACEHOLDER for Phase 3+.
 *
 * This stub preserves the modular interface for a future lightweight
 * general visual detector (e.g. a browser-compatible ViT/UI detector
 * loaded via ONNX Runtime Web).
 *
 * STATUS: NOT IMPLEMENTED.
 *   No model artifact is bundled.
 *   No ONNX Runtime Web is loaded.
 *   The stub reports availability = false unconditionally.
 *   The visual worker calls this stub AFTER MediaPipe face detection
 *   to provide a hook for the future model without architecture changes.
 *
 * WHEN A REAL MODEL IS SELECTED:
 *   Replace loadModel() with actual ONNX Runtime Web initialization.
 *   Replace runInference() with actual model inference.
 *   Update isAvailable() to reflect real readiness.
 *   The rest of the pipeline (fusion, sanitization) needs no changes.
 *
 * PUBLIC API (must be preserved when implementing):
 *   isAvailable()       → boolean
 *   loadModel(options)  → Promise<boolean>
 *   runInference(image) → Promise<Detection[]>
 *
 * Expected output shape per detection (see perceptionSchema.js):
 *   {
 *     source:     'visual',
 *     type:       'button' | 'input' | 'icon' | 'visual_control' | etc.,
 *     category:   (normalized by perceptionSchema),
 *     confidence: number [0, 1],
 *     bbox:       { x, y, width, height }  (absolute image pixel coords)
 *   }
 *
 * FAILURE CONTRACT:
 *   runInference() must NEVER throw — it must return { available: false, detections: [] }.
 *   A visual model failure must never block the perception pipeline.
 *   A visual model failure must never cause a raw screenshot to be returned.
 *
 * DO NOT:
 *   - add OpenCV.js here
 *   - add multiple models
 *   - add a captioning model
 *   - make this the primary PII classifier
 *   - allow model failure to crash the visual worker
 */

'use strict';

/* ── State ─────────────────────────────────────────────────────────────── */
let _modelLoaded = false;
// let _session = null;  // future: ONNX InferenceSession

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Whether the visual model is ready for inference.
 * Always false until a real model artifact is integrated.
 *
 * @returns {boolean}
 */
function isAvailable() {
  return _modelLoaded;
}

/**
 * Load and initialize the visual model.
 * Currently a no-op stub — always resolves false.
 *
 * Future implementation should:
 *   1. Load ONNX Runtime Web (ort.js / ort-web.js)
 *   2. Create InferenceSession from the bundled model
 *   3. Warm up with a dummy forward pass
 *   4. Set _modelLoaded = true on success
 *
 * @param {object} [options]
 * @param {string} [options.modelUrl]   — extension URL for the ONNX model artifact
 * @param {string} [options.ortUrl]     — extension URL for ONNX Runtime Web
 * @param {string} [options.backend]    — 'webgpu' | 'wasm' (auto-select if omitted)
 * @returns {Promise<boolean>}          — true if model loaded successfully
 */
async function loadModel(options) {
  // STUB: no model artifact is available yet.
  // When a real model is selected, replace this body.
  console.info('[SIH][VisualModel] General visual model: NOT IMPLEMENTED (stub). Skipping.');
  _modelLoaded = false;
  return false;
}

/**
 * Run visual inference on a screenshot image.
 * Currently a no-op stub — always returns empty detections.
 *
 * Future implementation should:
 *   1. Preprocess: resize to model input resolution (e.g. 640x640)
 *   2. Run ONNX session.run(feeds)
 *   3. Postprocess: decode bounding boxes, apply NMS
 *   4. Map class IDs to CATEGORIES from perceptionSchema.js
 *   5. Return Detection[] in absolute image pixel coordinates
 *
 * @param {ImageBitmap|OffscreenCanvas} image  — screenshot input
 * @param {object} [options]
 * @param {number} [options.confidenceThreshold]  — default 0.5
 * @returns {Promise<{ available: boolean, detections: Array }>}
 */
async function runInference(image, options) {
  if (!_modelLoaded) {
    return {
      available: false,
      detections: [],
      reason: 'Visual model not loaded (stub — model selection pending)'
    };
  }

  // Future: run ONNX inference and return detections here.
  return { available: false, detections: [] };
}

/* ── Export ─────────────────────────────────────────────────────────────── */
// Visual worker context (module worker, 'use strict', no window)
if (typeof self !== 'undefined') {
  self.SIH_VisualModelStub = { isAvailable, loadModel, runInference };
}
// Node.js (tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isAvailable, loadModel, runInference };
}
