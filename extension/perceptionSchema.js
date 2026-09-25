/**
 * Perception Schema — SIH26171
 *
 * Canonical detection evidence shape shared by ALL local detectors.
 *
 * Every detector (dom, regex, ocr, face, visual) MUST produce Detection
 * objects conforming to this schema before feeding into detectionFusion.
 *
 * The schema is intentionally permissive — not every detector can populate
 * every field. Use null / undefined for fields a detector cannot know.
 *
 * SCHEMA INVARIANTS:
 *   - source:     string  — which detector produced this (dom|regex|ocr|face|visual)
 *   - type:       string  — the specific sub-type within the source
 *   - category:   string  — privacy or UI category (see CATEGORIES below)
 *   - confidence: number  — [0, 1] certainty from the detector
 *
 * All other fields are optional. Do NOT require a field that a detector
 * cannot reliably produce.
 *
 * This file is loaded as a content-script and exposes window.SIH_PerceptionSchema.
 * It is also importable as a module in the visual worker context.
 */

(function () {
  'use strict';

  /* ── Canonical source identifiers ─────────────────────────────────────── */
  const SOURCES = Object.freeze({
    DOM:    'dom',
    REGEX:  'regex',
    OCR:    'ocr',
    FACE:   'face',
    VISUAL: 'visual'   // General lightweight visual model (future slot)
  });

  /* ── Canonical category labels ─────────────────────────────────────────
   *
   * Privacy categories (PII):
   *   email, phone, credit_card, password, ssn, account,
   *   name_field, sensitive (generic fallback)
   *
   * UI / structural categories (visual context):
   *   face, button, input, link, image, icon, canvas_control,
   *   visual_control, text_region, embedded_viewer, unknown
   *
   * These are soft labels — fusion and sanitization are the authoritative
   * classification steps.
   */
  const CATEGORIES = Object.freeze({
    // PII / privacy
    EMAIL:       'email',
    PHONE:       'phone',
    CREDIT_CARD: 'credit_card',
    PASSWORD:    'password',
    SSN:         'ssn',
    ACCOUNT:     'account',
    NAME_FIELD:  'name_field',
    SENSITIVE:   'sensitive',

    // UI / Visual context
    FACE:           'face',
    BUTTON:         'button',
    INPUT:          'input',
    LINK:           'link',
    IMAGE:          'image',
    ICON:           'icon',
    CANVAS_CONTROL: 'canvas_control',
    VISUAL_CONTROL: 'visual_control',
    TEXT_REGION:    'text_region',
    EMBEDDED_VIEWER:'embedded_viewer',
    UNKNOWN:        'unknown'
  });

  /**
   * Normalize a category string from an existing detector type field.
   * Maps legacy type names to canonical CATEGORIES.
   *
   * @param {string} rawType  — e.g. "card", "name_field", "ssn"
   * @param {string} source   — detector source for context
   * @returns {string}  canonical category
   */
  function normalizeCategory(rawType, source) {
    if (!rawType) return source === SOURCES.FACE ? CATEGORIES.FACE : CATEGORIES.UNKNOWN;
    const t = String(rawType).toLowerCase().trim();
    switch (t) {
      case 'email':           return CATEGORIES.EMAIL;
      case 'phone':           return CATEGORIES.PHONE;
      case 'card':
      case 'credit_card':     return CATEGORIES.CREDIT_CARD;
      case 'password':        return CATEGORIES.PASSWORD;
      case 'ssn':             return CATEGORIES.SSN;
      case 'account':         return CATEGORIES.ACCOUNT;
      case 'name_field':      return CATEGORIES.NAME_FIELD;
      case 'face':            return CATEGORIES.FACE;
      case 'button':          return CATEGORIES.BUTTON;
      case 'input':           return CATEGORIES.INPUT;
      case 'link':            return CATEGORIES.LINK;
      case 'image':           return CATEGORIES.IMAGE;
      case 'icon':            return CATEGORIES.ICON;
      case 'canvas_control':  return CATEGORIES.CANVAS_CONTROL;
      case 'visual_control':  return CATEGORIES.VISUAL_CONTROL;
      case 'text_region':     return CATEGORIES.TEXT_REGION;
      case 'embedded_viewer': return CATEGORIES.EMBEDDED_VIEWER;
      case 'sensitive':       return CATEGORIES.SENSITIVE;
      default:                return CATEGORIES.SENSITIVE;
    }
  }

  /**
   * Returns true for categories that represent private/sensitive data.
   * Used by sanitization layer to decide whether to tokenize/redact.
   *
   * @param {string} category
   * @returns {boolean}
   */
  function isPrivacySensitive(category) {
    const privacyCategories = new Set([
      CATEGORIES.EMAIL,
      CATEGORIES.PHONE,
      CATEGORIES.CREDIT_CARD,
      CATEGORIES.PASSWORD,
      CATEGORIES.SSN,
      CATEGORIES.ACCOUNT,
      CATEGORIES.NAME_FIELD,
      CATEGORIES.SENSITIVE,
      CATEGORIES.FACE
    ]);
    return privacyCategories.has(category);
  }

  /**
   * Create a normalized Detection evidence object.
   *
   * Only provide what the detector actually knows.
   * Omit or pass null/undefined for unknown fields.
   *
   * @param {object} raw
   * @param {string}   raw.source      — SOURCES constant
   * @param {string}   raw.type        — detector-internal type label
   * @param {number}   raw.confidence  — [0, 1]
   * @param {string}  [raw.value]      — raw matched value (DEVICE-LOCAL ONLY, never crosses network)
   * @param {string}  [raw.elementId]  — ElementRegistry ID or DOM identifier
   * @param {object}  [raw.bbox]       — { x, y, width, height } absolute image pixels (worker space)
   * @param {object}  [raw.rect]       — { x, y, width, height } viewport CSS pixels (content-script space)
   * @param {object}  [raw.metadata]   — additional detector-specific data
   * @param {string}  [raw.id]         — optional stable detection ID
   * @returns {object} normalized Detection
   */
  function createDetection(raw) {
    const source     = String(raw.source     || SOURCES.DOM);
    const type       = String(raw.type       || 'unknown');
    const confidence = Math.max(0, Math.min(1, Number(raw.confidence) || 0));
    const category   = normalizeCategory(type, source);

    const detection = {
      source,
      type,
      category,
      confidence
    };

    // Optional fields — only include when present and non-null
    if (raw.id         != null) detection.id        = String(raw.id);
    if (raw.elementId  != null) detection.elementId = String(raw.elementId);
    if (raw.value      != null) detection.value     = raw.value; // raw; NEVER crosses network
    if (raw.bbox       != null) detection.bbox      = { ...raw.bbox };
    if (raw.rect       != null) detection.rect      = { ...raw.rect };
    if (raw.metadata   != null) detection.metadata  = { ...raw.metadata };

    // Provenance tracking — initialized to single-source array
    detection.provenance = raw.provenance ? [...raw.provenance] : [source];
    detection.sources    = detection.provenance;

    return detection;
  }

  /**
   * Validate that a Detection conforms to the minimum schema requirements.
   * Used in tests and fusion layer to reject malformed inputs.
   *
   * @param {object} detection
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateDetection(detection) {
    if (!detection || typeof detection !== 'object') {
      return { valid: false, reason: 'Detection is not an object' };
    }
    if (!detection.source || typeof detection.source !== 'string') {
      return { valid: false, reason: 'Missing or invalid source field' };
    }
    if (!detection.type || typeof detection.type !== 'string') {
      return { valid: false, reason: 'Missing or invalid type field' };
    }
    if (typeof detection.confidence !== 'number' || detection.confidence < 0 || detection.confidence > 1) {
      return { valid: false, reason: 'confidence must be a number in [0, 1]' };
    }
    return { valid: true };
  }

  const schema = {
    SOURCES,
    CATEGORIES,
    normalizeCategory,
    isPrivacySensitive,
    createDetection,
    validateDetection
  };

  // Content-script / test environment
  if (typeof window !== 'undefined') {
    window.SIH_PerceptionSchema = schema;
  }
  // Visual Worker / module environment
  if (typeof self !== 'undefined' && typeof window === 'undefined') {
    self.SIH_PerceptionSchema = schema;
  }
  // Node.js (tests)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = schema;
  }
})();
