/**
 * Detection Fusion — SIH26171
 *
 * Merges overlapping or duplicate detections from all local perception sources:
 *   dom, regex, ocr, face, visual
 *
 * FUSION RULES:
 *   1. Two detections are merged if:
 *      a. They reference the same raw value (after normalization), OR
 *      b. Their bounding boxes spatially overlap AND they share the same type.
 *   2. Merged detections take the MAX confidence from all contributing sources.
 *   3. Provenance arrays are deduplicated unions — every source is tracked.
 *   4. The 'value' field (raw PII) is preserved from the dominant (highest-confidence)
 *      detection only. Device-local; never crosses the network boundary.
 *   5. Bounding box: retained from first detection with a valid bbox; merger does not
 *      synthesize a combined bbox (union) — that is future work.
 *   6. Category: normalized via SIH_PerceptionSchema.normalizeCategory when available,
 *      falling back to the raw type string.
 *
 * PROVENANCE SEMANTICS:
 *   detection.provenance  = Array<source>   (all detectors that observed this evidence)
 *   detection.sources     = detection.provenance  (alias for compatibility)
 *
 * OUTPUT:
 *   Array of fused Detection objects with stable IDs:
 *   {
 *     id, source, type, category, confidence,
 *     bbox?, rect?, value?, elementId?,
 *     provenance, sources
 *   }
 *
 * This module exposes window.SIH_DetectionFusion and is loaded as a content-script.
 */

(function () {
  'use strict';

  /* ── Helpers ──────────────────────────────────────────────────────────── */

  function normalizeValue(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s\-()]/g, '');
  }

  function overlap(a, b) {
    if (!a || !b) return false;
    const aR = a.x + a.width;
    const aB = a.y + a.height;
    const bR = b.x + b.width;
    const bB = b.y + b.height;
    return a.x < bR && aR > b.x && a.y < bB && aB > b.y;
  }

  function getBbox(detection) {
    return detection.bbox || detection.rect || null;
  }

  /**
   * Normalize a category label.
   * Uses SIH_PerceptionSchema when available (content-script context);
   * falls back to a simple local table for worker/test contexts.
   */
  function normalizeCategory(type, source) {
    // Prefer schema helper if available in this context
    if (typeof window !== 'undefined' && window.SIH_PerceptionSchema?.normalizeCategory) {
      return window.SIH_PerceptionSchema.normalizeCategory(type, source);
    }
    if (typeof self !== 'undefined' && self.SIH_PerceptionSchema?.normalizeCategory) {
      return self.SIH_PerceptionSchema.normalizeCategory(type, source);
    }
    // Minimal local fallback (no runtime dependency)
    const t = String(type || '').toLowerCase().trim();
    const map = {
      email: 'email', phone: 'phone', card: 'credit_card', credit_card: 'credit_card',
      password: 'password', ssn: 'ssn', account: 'account', name_field: 'name_field',
      face: 'face', sensitive: 'sensitive',
      button: 'button', input: 'input', link: 'link', image: 'image', icon: 'icon',
      canvas_control: 'canvas_control', visual_control: 'visual_control',
      text_region: 'text_region', embedded_viewer: 'embedded_viewer'
    };
    return map[t] || (source === 'face' ? 'face' : 'sensitive');
  }

  /* ── Merge decision ───────────────────────────────────────────────────── */

  function canMerge(a, b) {
    // Same type required for both value-based and spatial merges
    if ((a.type || '') !== (b.type || '')) return false;

    // 1. Value equality
    const av = a.value;
    const bv = b.value;
    if (av && bv && normalizeValue(av) === normalizeValue(bv)) return true;

    // 2. Spatial overlap
    const ab = getBbox(a);
    const bb = getBbox(b);
    if (ab && bb && overlap(ab, bb)) return true;

    return false;
  }

  function mergeInto(target, source) {
    // Confidence: take the max
    target.confidence = Math.max(
      Number(target.confidence) || 0,
      Number(source.confidence) || 0
    );

    // Provenance: deduplicated union
    const existingProvenance = Array.isArray(target.provenance)
      ? target.provenance
      : [target.source || 'unknown'];
    const newSource = source.source || 'unknown';
    if (!existingProvenance.includes(newSource)) {
      existingProvenance.push(newSource);
    }
    target.provenance = existingProvenance;
    target.sources    = existingProvenance;

    // Bbox: keep first valid bbox (do not discard geometric evidence from later sources)
    if (!getBbox(target) && getBbox(source)) {
      if (source.bbox) target.bbox = { ...source.bbox };
      if (source.rect) target.rect = { ...source.rect };
    }

    // elementId: prefer non-null
    if (!target.elementId && source.elementId) {
      target.elementId = source.elementId;
    }

    return target;
  }

  /* ── Public API ───────────────────────────────────────────────────────── */

  /**
   * Fuse an array of Detection objects from multiple sources.
   *
   * @param {Array} detections  — raw detections from all detectors
   * @returns {Array}           — fused detections with stable IDs and provenance
   */
  function fuse(detections) {
    const input = Array.isArray(detections) ? detections : [];
    const fused = [];

    for (const detection of input) {
      if (!detection || !detection.type) continue;

      const category = normalizeCategory(detection.type, detection.source);

      const existing = fused.find(candidate => canMerge(candidate, detection));

      if (existing) {
        mergeInto(existing, detection);
        // Update category if merging from a more specific source
        // (e.g. dom may detect 'email' where regex also finds 'email')
        if (!existing.category || existing.category === 'sensitive') {
          existing.category = category;
        }
      } else {
        // New detection: normalize and push
        const initialProvenance = Array.isArray(detection.provenance)
          ? [...detection.provenance]
          : [detection.source || 'unknown'];

        fused.push({
          ...detection,
          category,
          provenance: initialProvenance,
          sources: initialProvenance
        });
      }
    }

    // Assign stable IDs
    return fused.map((d, index) => ({
      ...d,
      id: d.id || `${d.source || 'detection'}_${index + 1}`
    }));
  }

  /* ── Expose ───────────────────────────────────────────────────────────── */
  const module_ = { fuse, normalizeValue, normalizeCategory, overlap, getBbox, canMerge };

  if (typeof window !== 'undefined') {
    window.SIH_DetectionFusion = module_;
  }
  if (typeof self !== 'undefined' && typeof window === 'undefined') {
    self.SIH_DetectionFusion = module_;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = module_;
  }
})();
