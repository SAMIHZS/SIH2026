/**
 * Phase 2 performance metrics.
 * Stores numeric timings and status only; never records page content or PII.
 */
(function() {
  'use strict';

  const STAGES = [
    'domMs', 'regexMs', 'gateMs', 'screenshotMs', 'preprocessMs',
    'ocrInitMs', 'ocrMs', 'cvInitMs', 'cvMs', 'fusionMs',
    'redactionMs', 'sanitizeMs', 'modelMs', 'totalMs'
  ];

  function createMetrics() {
    const metrics = { detectorStages: {}, failures: [], startedAt: performance.now() };
    for (const stage of STAGES) metrics[stage] = 0;
    return metrics;
  }

  function measure(metrics, stage, callback) {
    const start = performance.now();
    try {
      const result = callback();
      metrics[stage] = Math.max(0, performance.now() - start);
      return result;
    } catch (error) {
      metrics[stage] = Math.max(0, performance.now() - start);
      recordFailure(metrics, stage, error);
      throw error;
    }
  }

  async function measureAsync(metrics, stage, callback) {
    const start = performance.now();
    try {
      const result = await callback();
      metrics[stage] = Math.max(0, performance.now() - start);
      return result;
    } catch (error) {
      metrics[stage] = Math.max(0, performance.now() - start);
      recordFailure(metrics, stage, error);
      throw error;
    }
  }

  function recordFailure(metrics, stage, error) {
    metrics.failures.push({
      stage,
      message: error && error.message ? String(error.message).substring(0, 160) : 'Unknown failure'
    });
  }

  function finish(metrics) {
    metrics.totalMs = Math.max(0, performance.now() - metrics.startedAt);
    delete metrics.startedAt;
    return snapshot(metrics);
  }

  function snapshot(metrics) {
    return {
      ...metrics,
      failures: metrics.failures.map(failure => ({ ...failure })),
      detectorStages: { ...metrics.detectorStages }
    };
  }

  if (typeof window !== 'undefined') {
    window.SIH_Metrics = { createMetrics, measure, measureAsync, recordFailure, finish, snapshot };
  }
})();
