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
 * @returns {ValidationResult}
 */
function validateAction(action) {
  // 1. Basic structure check
  if (!action || typeof action !== 'object') {
    return { allowed: false, reason: 'Action is not a valid object' };
  }
  
  // 2. Action type allowlist
  if (!action.action || !ALLOWED_ACTIONS.includes(action.action)) {
    return { allowed: false, reason: `Action type "${action.action}" is not allowlisted. Allowed: ${ALLOWED_ACTIONS.join(', ')}` };
  }
  
  // 3. Target required for click and type
  if (['click', 'type'].includes(action.action)) {
    if (!action.target || typeof action.target !== 'string') {
      return { allowed: false, reason: 'Action requires a target selector' };
    }
    
    // 3a. Validate selector is safe (no JavaScript, no eval patterns)
    if (containsDangerousPattern(action.target)) {
      return { allowed: false, reason: 'Target selector contains dangerous pattern' };
    }
    
    // 3b. Target must exist in DOM
    let targetElement;
    try {
      targetElement = document.querySelector(action.target);
    } catch (e) {
      return { allowed: false, reason: `Invalid CSS selector: ${action.target}` };
    }
    
    if (!targetElement) {
      return { allowed: false, reason: `Target element not found: ${action.target}` };
    }
    
    // 3c. Target must be visible
    if (typeof window.SIH_DomDetector !== 'undefined' && !window.SIH_DomDetector.isElementVisible(targetElement)) {
      return { allowed: false, reason: 'Target element is not visible' };
    }
    
    // 3d. Check protected elements
    for (const selector of PROTECTED_SELECTORS) {
      if (targetElement.matches(selector)) {
        return { allowed: false, reason: `Target is a protected element: ${selector}` };
      }
    }
    
    // 3e. Click-specific protections
    if (action.action === 'click') {
      for (const selector of PROTECTED_CLICK_SELECTORS) {
        if (targetElement.matches(selector)) {
          return { allowed: false, reason: `Target is protected from click: ${selector}` };
        }
      }
    }
    
    // 3f. Type action requires a value
    if (action.action === 'type') {
      if (action.value === undefined || action.value === null) {
        return { allowed: false, reason: 'Type action requires a value parameter' };
      }
      // Validate the element can accept text input
      const tag = targetElement.tagName.toLowerCase();
      if (!['input', 'textarea', 'select'].includes(tag) && !targetElement.isContentEditable) {
        return { allowed: false, reason: 'Target element cannot accept text input' };
      }
    }
  }
  
  // 4. Scroll validation
  if (action.action === 'scroll') {
    // Scroll can have a target (scroll element into view) or no target (scroll page)
    if (action.target) {
      try {
        const el = document.querySelector(action.target);
        if (!el) {
          return { allowed: false, reason: `Scroll target not found: ${action.target}` };
        }
      } catch (e) {
        return { allowed: false, reason: `Invalid scroll target selector: ${action.target}` };
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

// Expose for content.js
if (typeof window !== 'undefined') {
  window.SIH_Validator = { validateAction, validateActionSchema, containsDangerousPattern };
}
