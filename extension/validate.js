/**
 * Action Validator — SIH26171 Phase 1
 * 
 * Validates structured Actions before browser execution.
 * 
 * Checks:
 * 1. Action type is allowlisted (click, type, scroll)
 * 2. Target exists in current DOM
 * 3. Target is valid/expected element for that action
 * 4. Target is not protected/sensitive
 * 5. Parameters are structurally valid
 * 
 * Returns ValidationResult (internal, never crosses network boundary).
 */

// Phase 1 allowlisted action types
const ALLOWED_ACTIONS = ['click', 'type', 'scroll'];

// Selectors for protected/sensitive elements that should not be automated
const PROTECTED_SELECTORS = [
  'input[type="password"]', // Never auto-type into password fields
];

// Elements that should not be clicked
const PROTECTED_CLICK_SELECTORS = [
  // Browser extension UI elements
  '[data-sih-protected]',
];

/**
 * Validate an Action from the remote LLM.
 * Returns ValidationResult: { allowed: boolean, reason?: string }
 * 
 * @param {Action} action - The action to validate
 * @param {number} [expectedGeneration] - Active page context generation
 * @returns {ValidationResult}
 */
function validateAction(action, expectedGeneration, expectedTabId) {
  // 1. Basic structure check
  if (!action || typeof action !== 'object') {
    return { allowed: false, reason: 'Action is not a valid object' };
  }

  // Normalize action type and target fields
  const actionType = (action.action || action.type || '').toLowerCase();
  const targetId = action.target || action.elementId;

  // 1a. Generation check if action carries a generation
  if (typeof action.generation === 'number' && typeof expectedGeneration === 'number') {
    if (action.generation !== expectedGeneration) {
      return { allowed: false, reason: `Action rejected: action generation (${action.generation}) does not match current page generation (${expectedGeneration})` };
    }
  }

  // 1b. Tab check if action carries a tabId
  if (typeof action.tabId === 'number' && typeof expectedTabId === 'number') {
    if (action.tabId !== expectedTabId) {
      return { allowed: false, reason: `Action rejected: action tabId (${action.tabId}) does not match current tabId (${expectedTabId})` };
    }
  }

  // 2. Action type allowlist
  if (!actionType || !ALLOWED_ACTIONS.includes(actionType)) {
    return { allowed: false, reason: `Action type "${actionType}" is not allowlisted. Allowed: ${ALLOWED_ACTIONS.join(', ')}` };
  }

  // 3. Target required for click and type
  if (['click', 'type'].includes(actionType)) {
    if (!targetId || typeof targetId !== 'string') {
      return { allowed: false, reason: 'Action requires a target selector' };
    }

    // 3a. Reject arbitrary model-generated CSS selectors, XPath, and JS code
    if (!/^el_\d+$/.test(targetId)) {
      return { allowed: false, reason: `Arbitrary selector rejected: target must be a valid ElementRegistry ID (el_X), got "${targetId}"` };
    }

    // 3b. Validate target is safe (no JavaScript, no eval patterns)
    if (containsDangerousPattern(targetId)) {
      return { allowed: false, reason: 'Target selector contains dangerous pattern' };
    }

    // 3c. Target must be a valid registered element in the DOM (isolated to current generation)
    if (typeof window.SIH_ElementRegistry === 'undefined' || !window.SIH_ElementRegistry.resolve) {
      return { allowed: false, reason: 'Element registry unavailable' };
    }

    const targetElement = window.SIH_ElementRegistry.resolve(targetId, expectedGeneration);
    if (!targetElement) {
      return { allowed: false, reason: `Target element not found or belongs to a different page generation: ${targetId}` };
    }

    // 3d. Target must not be disabled
    if (targetElement.disabled || targetElement.hasAttribute('disabled') || targetElement.getAttribute('aria-disabled') === 'true') {
      return { allowed: false, reason: 'Target element is disabled' };
    }

    // 3e. Target must be visible
    if (targetElement.hasAttribute('hidden') || targetElement.getAttribute('aria-hidden') === 'true') {
      return { allowed: false, reason: 'Target element is not visible' };
    }

    if (typeof window.SIH_DomDetector !== 'undefined' && !window.SIH_DomDetector.isElementVisible(targetElement)) {
      return { allowed: false, reason: 'Target element is not visible' };
    }

    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const cs = window.getComputedStyle(targetElement);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity || '1') <= 0) {
        return { allowed: false, reason: 'Target element is not visible' };
      }
    }

    // 3f. Check protected elements
    for (const selector of PROTECTED_SELECTORS) {
      if (targetElement.matches(selector)) {
        return { allowed: false, reason: `Target is a protected element: ${selector}` };
      }
    }

    // 3g. Click-specific protections
    if (actionType === 'click') {
      for (const selector of PROTECTED_CLICK_SELECTORS) {
        if (targetElement.matches(selector)) {
          return { allowed: false, reason: `Target is protected from click: ${selector}` };
        }
      }
    }

    // 3h. Type action validation
    if (actionType === 'type') {
      if (action.value === undefined || action.value === null) {
        return { allowed: false, reason: 'Type action requires a value parameter' };
      }
      if (typeof action.value !== 'string') {
        return { allowed: false, reason: 'Type action value must be a string' };
      }
      if (containsDangerousPattern(action.value)) {
        return { allowed: false, reason: 'Type value contains dangerous script pattern' };
      }
      // Validate the element can accept text input
      const tag = targetElement.tagName.toLowerCase();
      if (!['input', 'textarea', 'select'].includes(tag) && !targetElement.isContentEditable) {
        return { allowed: false, reason: 'Target element cannot accept text input' };
      }
    }
  }

  // 4. Scroll validation
  if (actionType === 'scroll') {
    if (targetId) {
      if (typeof targetId !== 'string') {
        return { allowed: false, reason: 'Scroll target must be a string' };
      }
      if (!/^el_\d+$/.test(targetId)) {
        return { allowed: false, reason: `Arbitrary selector rejected: scroll target must be a valid ElementRegistry ID (el_X)` };
      }
      if (containsDangerousPattern(targetId)) {
        return { allowed: false, reason: 'Target selector contains dangerous pattern' };
      }
      if (typeof window.SIH_ElementRegistry === 'undefined' || !window.SIH_ElementRegistry.resolve) {
        return { allowed: false, reason: 'Element registry unavailable' };
      }
      const el = window.SIH_ElementRegistry.resolve(targetId, expectedGeneration);
      if (!el) {
        return { allowed: false, reason: `Scroll target not found or belongs to a different page generation: ${targetId}` };
      }
    }
    if (action.value !== undefined) {
      const rawAmt = parseInt(action.value, 10);
      if (!isNaN(rawAmt) && (rawAmt < -2000 || rawAmt > 2000)) {
        return { allowed: false, reason: 'Scroll amount exceeds allowed bounds (-2000 to +2000)' };
      }
    }
  }

  return { allowed: true };
}

/**
 * Check if a string contains dangerous patterns.
 * Prevents eval, javascript:, script injection via selectors.
 */
function containsDangerousPattern(str) {
  if (!str || typeof str !== 'string') return false;
  const lower = str.toLowerCase();
  const dangerous = [
    'javascript:',
    'eval(',
    'eval (',
    'function(',
    'function (',
    '<script',
    'onerror',
    'onload',
    'onclick',
    'onmouse',
    'onfocus',
    'onblur',
    'onchange',
    'onsubmit',
    'expression(',
    'url(',
    'import(',
    'import (',
    'require('
  ];
  return dangerous.some(pattern => lower.includes(pattern));
}

/**
 * Validate the Action schema structure (matches frozen schema).
 */
function validateActionSchema(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'Response is not an object' };
  }
  
  if (!data.action || typeof data.action !== 'string') {
    return { valid: false, reason: 'Missing or invalid "action" field' };
  }
  
  if (data.target !== undefined && typeof data.target !== 'string') {
    return { valid: false, reason: '"target" must be a string' };
  }
  
  if (data.value !== undefined && typeof data.value !== 'string') {
    return { valid: false, reason: '"value" must be a string' };
  }
  
  return { valid: true };
}

// Expose for content.js & test environments
if (typeof window !== 'undefined') {
  window.SIH_Validator = { validateAction, validateActionSchema, containsDangerousPattern };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateAction, validateActionSchema, containsDangerousPattern, ALLOWED_ACTIONS };
}
