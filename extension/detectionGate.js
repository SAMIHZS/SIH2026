/**
 * Phase 2 deterministic detector gate.
 * DOM and Regex remain the cheap fast path; visual stages are conditional.
 */
(function() {
  'use strict';

  const DETECTOR_COST = Object.freeze({ DOM: 1, REGEX: 2, OCR: 5, CV: 8 });
  const DEFAULT_GATE_CONFIG = Object.freeze({
    minimumConfidence: 0.8,
    minimumDetections: 1,
    allowOcr: true,
    allowCv: true,
    requireVisualEvidenceForCv: true
  });

  function normalizeConfig(config) {
    return { ...DEFAULT_GATE_CONFIG, ...(config || {}) };
  }

  function hasVisualEvidence(input) {
    return Boolean(
      input && (
        input.imageCount > 0 ||
        input.canvasCount > 0 ||
        input.imageHeavy ||
        input.visualRegions > 0
      )
    );
  }

  function confidenceIsSufficient(detections, config) {
    if (!Array.isArray(detections) || detections.length < config.minimumDetections) return false;
    return detections.some(detection => Number(detection.confidence) >= config.minimumConfidence);
  }

  function decide(input) {
    const config = normalizeConfig(input && input.config);
    const detections = Array.isArray(input && input.detections) ? input.detections : [];
    const visualEvidence = hasVisualEvidence(input);
    const decision = {
      runOcr: false,
      runCv: false,
      reason: 'cheap-detectors-sufficient',
      estimatedCost: DETECTOR_COST.DOM + DETECTOR_COST.REGEX,
      visualEvidence
    };

    if (confidenceIsSufficient(detections, config)) return decision;
    if (!visualEvidence) {
      decision.reason = 'no-visual-evidence';
      return decision;
    }

    if (config.allowOcr && input?.ocrAvailable !== false) {
      decision.runOcr = true;
      decision.estimatedCost += DETECTOR_COST.OCR;
      decision.reason = 'insufficient-cheap-detector-confidence';
    } else if (config.allowOcr) {
      decision.reason = 'ocr-unavailable';
    }

    if (!config.allowCv || !config.requireVisualEvidenceForCv || visualEvidence) {
      decision.runCv = Boolean(config.allowCv && input?.cvAvailable !== false && !decision.runOcr);
      if (config.allowCv && input?.cvAvailable === false && !decision.runOcr) decision.reason = 'cv-unavailable';
    }

    return decision;
  }

  function decideAfterOcr(input) {
    const config = normalizeConfig(input && input.config);
    const detections = Array.isArray(input && input.detections) ? input.detections : [];
    const visualEvidence = hasVisualEvidence(input);
    const decision = {
      runCv: false,
      reason: 'ocr-sufficient',
      estimatedCost: DETECTOR_COST.OCR
    };

    if (confidenceIsSufficient(detections, config)) return decision;
    if (config.allowCv && visualEvidence) {
      decision.runCv = true;
      decision.reason = 'ocr-insufficient-confidence';
      decision.estimatedCost += DETECTOR_COST.CV;
    } else {
      decision.reason = visualEvidence ? 'cv-disabled' : 'no-visual-evidence';
    }
    return decision;
  }

  if (typeof window !== 'undefined') {
    window.SIH_DetectionGate = { DETECTOR_COST, DEFAULT_GATE_CONFIG, decide, decideAfterOcr, hasVisualEvidence };
  }
})();
