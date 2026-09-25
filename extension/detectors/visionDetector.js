/*
 * Lazy local vision detector boundary.
 * Phase 2 keeps the first visual capability narrow and never fakes detections.
 */
(function() {
  'use strict';

  let runtimeLoader = null;
  let runtime = null;

  function configureLoader(loader) {
    runtimeLoader = typeof loader === 'function' ? loader : null;
  }

  function isAvailable() {
    return Boolean(runtimeLoader);
  }

  async function loadRuntime() {
    if (runtime) return runtime;
    if (!runtimeLoader) return null;
    runtime = await runtimeLoader();
    return runtime;
  }

  async function detect(image, options) {
    const initStarted = performance.now();
    const loaded = await loadRuntime();
    const cvInitMs = performance.now() - initStarted;
    if (!loaded || typeof loaded.detect !== 'function') {
      return { available: false, detections: [], reason: 'Vision runtime is not installed', timings: { cvInitMs } };
    }
    const inferenceStarted = performance.now();
    const results = await loaded.detect(image, options || {});
    const cvMs = performance.now() - inferenceStarted;
    return {
      available: true,
      timings: { cvInitMs, cvMs },
      detections: (Array.isArray(results) ? results : []).map((result, index) => ({
        id: result.id || `vision_${index + 1}`,
        type: result.type || 'face',
        source: 'vision',
        confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
        ...(result.bbox ? { bbox: { ...result.bbox }, rect: { ...result.bbox } } : {})
      }))
    };
  }

  if (typeof self !== 'undefined') self.SIH_VisionDetector = { configureLoader, isAvailable, loadRuntime, detect };
})();
