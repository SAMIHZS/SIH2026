/**
 * Phase 2 detection fusion.
 * Raw values are used only for local grouping before sanitization.
 */
(function() {
  'use strict';

  function normalizeValue(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s\-()]/g, '');
  }

  function overlap(first, second) {
    if (!first || !second) return false;
    const firstRight = first.x + first.width;
    const firstBottom = first.y + first.height;
    const secondRight = second.x + second.width;
    const secondBottom = second.y + second.height;
    return first.x < secondRight && firstRight > second.x && first.y < secondBottom && firstBottom > second.y;
  }

  function mergeInto(target, source) {
    target.confidence = Math.max(Number(target.confidence) || 0, Number(source.confidence) || 0);
    target.provenance = Array.from(new Set([...(target.provenance || [target.source]), source.source]));
    target.sources = target.provenance;
    if (!target.rect && source.rect) target.rect = { ...source.rect };
    if (!target.bbox && source.bbox) target.bbox = { ...source.bbox };
    if (!target.elementId && source.elementId) target.elementId = source.elementId;
    return target;
  }

  function canMerge(first, second) {
    const sameValue = first.value && second.value && normalizeValue(first.value) === normalizeValue(second.value);
    const firstBox = first.bbox || first.rect;
    const secondBox = second.bbox || second.rect;
    const sameRegion = firstBox && secondBox && overlap(firstBox, secondBox) && first.type === second.type;
    return Boolean(sameValue || sameRegion);
  }

  function fuse(detections) {
    const fused = [];
    for (const detection of Array.isArray(detections) ? detections : []) {
      if (!detection || !detection.type) continue;
      const existing = fused.find(candidate => canMerge(candidate, detection));
      if (existing) {
        mergeInto(existing, detection);
      } else {
        fused.push({
          ...detection,
          provenance: Array.from(new Set([...(detection.provenance || []), detection.source || 'unknown'])),
          sources: Array.from(new Set([...(detection.provenance || []), detection.source || 'unknown']))
        });
      }
    }
    return fused.map((detection, index) => ({
      ...detection,
      id: detection.id || `${detection.source || 'detection'}_${index + 1}`
    }));
  }

  if (typeof window !== 'undefined') {
    window.SIH_DetectionFusion = { fuse, normalizeValue, overlap };
  }
})();
