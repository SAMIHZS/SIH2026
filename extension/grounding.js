/**
 * Multimodal Page Grounding — SIH26171 Phase 7 Architecture
 *
 * Deterministically correlates DOM interactive elements, OCR text regions,
 * and visual coordinates into unambiguous ElementRegistry identities.
 *
 * Invariants:
 * 1. Coordinates and OCR text are EVIDENCE ONLY — neither is an execution primitive.
 * 2. Model outputs must resolve to a valid, connected, visible, enabled ElementRegistry target.
 * 3. Arbitrary model-generated CSS selectors, XPath, and JavaScript are strictly rejected.
 * 4. Ambiguous matches (multiple identical candidates) fail closed with AMBIGUOUS_TARGET.
 * 5. All grounding operations are strictly generation- and tab-bound.
 * 6. Diagnostics are metadata-only (zero OCR text, zero DOM dumps, zero image data).
 */
(function() {
  'use strict';

  let lastDiagnostics = {
    candidates: 0,
    matched: 0,
    ambiguous: false,
    generation: 0,
    tabId: null
  };

  /**
   * Determine if an element is visible in the viewport and interactable.
   *
   * @param {Element} element
   * @returns {boolean}
   */
  function isElementInteractable(element) {
    if (!element || !element.isConnected) return false;

    // Check disabled state
    if (element.disabled || element.hasAttribute('disabled')) return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;

    // Check hidden attribute
    if (element.hasAttribute('hidden')) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;

    // Check computed geometry & styling
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(element);
      if (style.display === 'none') return false;
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (parseFloat(style.opacity || '1') <= 0) return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    return true;
  }

  /**
   * Extract internal grounded element descriptor.
   * Internal representation only — never forwarded to remote AI verbatim.
   *
   * @param {Element} element
   * @param {number} generation
   * @param {number} [tabId]
   * @returns {object|null}
   */
  function buildGroundedElement(element, generation, tabId) {
    if (!element || !element.isConnected) return null;
    if (!isElementInteractable(element)) return null;

    const registry = (typeof window !== 'undefined' && window.SIH_ElementRegistry)
      ? window.SIH_ElementRegistry
      : null;

    const elementId = registry ? registry.register(element, generation) : null;
    if (!elementId) return null;

    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role') || tag;
    const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
    const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || '';

    return {
      elementId,
      generation,
      tabId: tabId || null,
      tag,
      role,
      text: text.substring(0, 150),
      label: label.substring(0, 150),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      visible: true,
      enabled: true
    };
  }

  /**
   * Collect all interactive page elements and register them for current generation.
   *
   * @param {number} generation
   * @param {number} [tabId]
   * @returns {Array<object>}
   */
  function buildGroundedInventory(generation, tabId) {
    if (typeof document === 'undefined') return [];

    const selectors = [
      'a[href]',
      'button:not([disabled])',
      'input:not([type="hidden"]):not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[role="button"]',
      '[role="link"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const domNodes = Array.from(document.querySelectorAll(selectors));
    const inventory = [];
    const seen = new Set();

    for (const node of domNodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      const item = buildGroundedElement(node, generation, tabId);
      if (item) inventory.push(item);
    }

    lastDiagnostics = {
      candidates: inventory.length,
      matched: 0,
      ambiguous: false,
      generation,
      tabId: tabId || null
    };

    return inventory;
  }

  /**
   * Correlate OCR bounding boxes with DOM elements.
   * OCR phrase -> overlapping DOM candidate -> ElementRegistry target ID.
   *
   * @param {Array<{ text: string, bbox: { x: number, y: number, width: number, height: number } }>} ocrDetections
   * @param {number} generation
   * @returns {Array<{ ocrPhrase: string, elementId: string, confidence: number }>}
   */
  function correlateOcrWithDom(ocrDetections, generation) {
    if (!Array.isArray(ocrDetections) || ocrDetections.length === 0) return [];
    const inventory = buildGroundedInventory(generation);
    const correlations = [];

    for (const ocr of ocrDetections) {
      if (!ocr || !ocr.bbox) continue;
      const ocrText = (ocr.text || '').toLowerCase().trim();
      if (!ocrText) continue;

      const ox = ocr.bbox.x;
      const oy = ocr.bbox.y;
      const ow = ocr.bbox.width;
      const oh = ocr.bbox.height;

      // Find overlapping DOM elements
      for (const item of inventory) {
        const dx = item.rect.x;
        const dy = item.rect.y;
        const dw = item.rect.width;
        const dh = item.rect.height;

        // Bounding box intersection check
        const xOverlap = Math.max(0, Math.min(ox + ow, dx + dw) - Math.max(ox, dx));
        const yOverlap = Math.max(0, Math.min(oy + oh, dy + dh) - Math.max(oy, dy));
        const overlapArea = xOverlap * yOverlap;

        if (overlapArea > 0 || item.text.toLowerCase().includes(ocrText) || ocrText.includes(item.text.toLowerCase())) {
          correlations.push({
            ocrPhrase: ocr.text,
            elementId: item.elementId,
            generation,
            confidence: overlapArea > 0 ? 0.9 : 0.75
          });
        }
      }
    }

    return correlations;
  }

  /**
   * Resolve model semantic intent to a single unambiguous ElementRegistry identity.
   *
   * @param {object} intent - Intent specification: { elementId?, text?, role?, coordinates?: { x, y } }
   * @param {number} generation - Current active generation
   * @param {number} [tabId] - Current active tabId
   * @returns {{ success: boolean, elementId?: string, error?: string, diagnostics: object }}
   */
  function groundIntent(intent, generation, tabId) {
    if (!intent || typeof intent !== 'object') {
      return { success: false, error: 'INVALID_INTENT', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
    }

    const registry = (typeof window !== 'undefined' && window.SIH_ElementRegistry)
      ? window.SIH_ElementRegistry
      : null;

    if (!registry) {
      return { success: false, error: 'ELEMENT_REGISTRY_UNAVAILABLE', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
    }

    // 1. Direct elementId target (canonical model reference)
    const rawTarget = intent.elementId || intent.target;
    if (typeof rawTarget === 'string' && /^el_\d+$/.test(rawTarget)) {
      const resolved = registry.resolve(rawTarget, generation);
      if (!resolved) {
        return { success: false, error: 'STALE_OR_UNKNOWN_ELEMENT', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
      }
      if (!isElementInteractable(resolved)) {
        return { success: false, error: 'ELEMENT_NOT_INTERACTABLE', diagnostics: { candidates: 1, matched: 0, ambiguous: false } };
      }
      lastDiagnostics = { candidates: 1, matched: 1, ambiguous: false, generation, tabId: tabId || null };
      return { success: true, elementId: rawTarget, diagnostics: lastDiagnostics };
    }

    // 2. Reject arbitrary CSS/XPath/JS selectors generated by model
    if (typeof rawTarget === 'string' && !/^el_\d+$/.test(rawTarget)) {
      return { success: false, error: 'UNSAFE_SELECTOR_REJECTED', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
    }

    // 3. Semantic Search across Grounded Inventory
    const inventory = buildGroundedInventory(generation, tabId);
    let candidates = [...inventory];

    // Filter by role if provided
    const roleVal = intent.role || intent.semanticRole;
    if (roleVal) {
      const roleQuery = String(roleVal).toLowerCase();
      candidates = candidates.filter(c => c.role.toLowerCase() === roleQuery || c.tag === roleQuery);
    }

    // Filter by text / label query
    const textVal = intent.text || intent.targetText;
    if (textVal) {
      const textQuery = String(textVal).toLowerCase().trim();
      candidates = candidates.filter(c =>
        c.text.toLowerCase().includes(textQuery) ||
        c.label.toLowerCase().includes(textQuery) ||
        textQuery.includes(c.text.toLowerCase())
      );
    }

    // Visual coordinate evidence (coordinates are EVIDENCE for grounding, NEVER execution primitives)
    if (intent.coordinates && typeof intent.coordinates.x === 'number' && typeof intent.coordinates.y === 'number') {
      const px = intent.coordinates.x;
      const py = intent.coordinates.y;
      candidates = candidates.filter(c =>
        px >= c.rect.x &&
        px <= (c.rect.x + c.rect.width) &&
        py >= c.rect.y &&
        py <= (c.rect.y + c.rect.height)
      );
    }

    // Evaluate result multiplicity
    if (candidates.length === 0) {
      lastDiagnostics = { candidates: 0, matched: 0, ambiguous: false, generation, tabId: tabId || null };
      return { success: false, error: 'ELEMENT_NOT_FOUND', diagnostics: lastDiagnostics };
    }

    if (candidates.length > 1) {
      // Ambiguous target: multiple matching elements on page
      lastDiagnostics = { candidates: candidates.length, matched: 0, ambiguous: true, generation, tabId: tabId || null };
      return { success: false, error: 'AMBIGUOUS_TARGET', diagnostics: lastDiagnostics };
    }

    // Exactly 1 unambiguous match
    const matched = candidates[0];
    lastDiagnostics = { candidates: 1, matched: 1, ambiguous: false, generation, tabId: tabId || null };
    return { success: true, elementId: matched.elementId, diagnostics: lastDiagnostics };
  }

  /**
   * Validate and normalize a structured model output.
   * Enforces:
   * 1. Action type allowlist
   * 2. Grounding resolution to valid ElementRegistry target
   * 3. Generation and tab matching
   * 4. Safe parameters (bounded scroll, validated typing)
   *
   * @param {object} modelOutput - { message?, actions?: Array<object>, action?: object }
   * @param {number} expectedGeneration
   * @param {number} [expectedTabId]
   * @returns {{ valid: boolean, actions: Array<object>, error?: string, diagnostics: object }}
   */
  function validateModelResponse(modelOutput, expectedGeneration, expectedTabId) {
    if (!modelOutput || typeof modelOutput !== 'object') {
      return { valid: false, actions: [], error: 'MALFORMED_RESPONSE', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
    }

    if (modelOutput.actions !== undefined && !Array.isArray(modelOutput.actions)) {
      return { valid: false, actions: [], error: 'ACTIONS_NOT_AN_ARRAY', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
    }

    // Extract raw action list
    let actionList = [];
    if (Array.isArray(modelOutput.actions)) {
      actionList = modelOutput.actions;
    } else if (modelOutput.action && typeof modelOutput.action === 'object') {
      actionList = [modelOutput.action];
    } else if (typeof modelOutput.action === 'string') {
      actionList = [modelOutput];
    } else if (typeof modelOutput.type === 'string') {
      actionList = [modelOutput];
    }

    if (actionList.length === 0) {
      return { valid: true, actions: [], diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
    }

    const validatedActions = [];

    for (const rawAction of actionList) {
      if (!rawAction || typeof rawAction !== 'object') {
        return { valid: false, actions: [], error: 'MALFORMED_ACTION', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
      }

      // Check action type allowlist
      const actionType = (rawAction.type || rawAction.action || '').toLowerCase();
      if (!['click', 'type', 'scroll'].includes(actionType)) {
        return { valid: false, actions: [], error: 'UNKNOWN_ACTION_TYPE', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
      }

      // Generation check
      if (typeof rawAction.generation === 'number' && typeof expectedGeneration === 'number') {
        if (rawAction.generation !== expectedGeneration) {
          return { valid: false, actions: [], error: 'STALE_GENERATION', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
        }
      }

      // Tab check
      if (typeof rawAction.tabId === 'number' && typeof expectedTabId === 'number') {
        if (rawAction.tabId !== expectedTabId) {
          return { valid: false, actions: [], error: 'WRONG_TAB_ACTION', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
        }
      }

      // Scroll with no target is safe page scroll
      if (actionType === 'scroll' && !rawAction.elementId && !rawAction.target) {
        const rawAmt = parseInt(rawAction.value, 10) || 300;
        const boundedAmt = Math.max(-2000, Math.min(2000, rawAmt));
        validatedActions.push({
          action: 'scroll',
          target: null,
          value: String(boundedAmt),
          generation: expectedGeneration,
          tabId: expectedTabId || null
        });
        continue;
      }

      // Ground action target to ElementRegistry
      const groundResult = groundIntent(rawAction, expectedGeneration, expectedTabId);
      if (!groundResult.success) {
        return { valid: false, actions: [], error: groundResult.error, diagnostics: groundResult.diagnostics };
      }

      // Type action validation
      let value = rawAction.value;
      if (actionType === 'type') {
        if (typeof value !== 'string') {
          return { valid: false, actions: [], error: 'TYPE_ACTION_REQUIRES_STRING_VALUE', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
        }
        // Protect against JavaScript URL or script injection
        if (/javascript:|<script|eval\(/i.test(value)) {
          return { valid: false, actions: [], error: 'UNSAFE_TYPE_PAYLOAD', diagnostics: { candidates: 0, matched: 0, ambiguous: false } };
        }
      }

      // Scroll action bounding
      if (actionType === 'scroll') {
        const rawAmt = parseInt(value, 10) || 300;
        value = String(Math.max(-2000, Math.min(2000, rawAmt)));
      }

      validatedActions.push({
        action: actionType,
        target: groundResult.elementId,
        value: value !== undefined ? String(value) : undefined,
        generation: expectedGeneration,
        tabId: expectedTabId || null
      });
    }

    return {
      valid: true,
      actions: validatedActions,
      diagnostics: lastDiagnostics
    };
  }

  function getDiagnostics() {
    return { ...lastDiagnostics };
  }

  const Grounding = {
    isElementInteractable,
    buildGroundedElement,
    buildGroundedInventory,
    correlateOcrWithDom,
    groundIntent,
    validateModelResponse,
    getDiagnostics
  };

  if (typeof window !== 'undefined') {
    window.SIH_Grounding = Grounding;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Grounding;
  }
})();
