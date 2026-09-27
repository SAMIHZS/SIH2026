/**
 * Executor — SIH26171 Phase 1
 *
 * Executes validated browser actions.
 * Plain switch: click, type, scroll.
 *
 * NEVER uses: eval, new Function, arbitrary scripts.
 *
 * For React/Vue controlled inputs, dispatches appropriate
 * input/change events after setting values.
 */

/**
 * Execute a validated action in the browser.
 * Only call this AFTER validation has succeeded.
 *
 * Re-checks generation immediately before execution to protect against
 * validate -> navigation -> execute race conditions.
 *
 * @param {Action} action - The validated action to execute
 * @param {number} [currentGeneration] - Active page context generation
 * @returns {{ success: boolean, error?: string }}
 */
function executeAction(action, currentGeneration) {
  try {
    if (typeof action?.generation === 'number' && typeof currentGeneration === 'number') {
      if (action.generation !== currentGeneration) {
        return {
          success: false,
          error: `Action execution rejected: stale generation (action=${action.generation}, current=${currentGeneration})`
        };
      }
    }
    const actionType = (action.action || action.type || '').toLowerCase();
    const target = action.target || action.elementId;
    const normalized = { ...action, action: actionType, target };

    switch (actionType) {
      case 'click':
        return executeClick(normalized, currentGeneration);
      case 'type':
        return executeType(normalized, currentGeneration);
      case 'scroll':
        return executeScroll(normalized, currentGeneration);
      default:
        return { success: false, error: `Unknown action type: ${actionType}` };
    }
  } catch (err) {
    return { success: false, error: `Execution error: ${err.message}` };
  }
}

/**
 * Execute a click action.
 */
function executeClick(action, currentGeneration) {
  const element = window.SIH_ElementRegistry ? window.SIH_ElementRegistry.resolve(action.target, currentGeneration) : null;
  if (!element) {
    return { success: false, error: `Click target not found: ${action.target}` };
  }

  // Scroll into view first if supported
  if (typeof element.scrollIntoView === 'function') {
    try {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (_) {}
  }

  // Click the element
  if (typeof element.click === 'function') {
    try {
      element.click();
    } catch (err) {
      return { success: false, error: `Click failed: ${err.message}` };
    }
  }

  return { success: true };
}

/**
 * Execute a type action.
 * Handles React/Vue/controlled inputs by dispatching synthetic events.
 */
function executeType(action, currentGeneration) {
  const element = window.SIH_ElementRegistry ? window.SIH_ElementRegistry.resolve(action.target, currentGeneration) : null;
  if (!element) {
    return { success: false, error: `Type target not found: ${action.target}` };
  }

  // Focus the element if supported
  if (typeof element.focus === 'function') {
    try {
      element.focus();
    } catch (_) {}
  }

  // Set value
  const hasWindow = typeof window !== 'undefined';
  const nativeInputValueSetter = (hasWindow && window.HTMLInputElement)
    ? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    : null;
  const nativeTextAreaValueSetter = (hasWindow && window.HTMLTextAreaElement)
    ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    : null;

  if (element.tagName === 'INPUT' && nativeInputValueSetter) {
    nativeInputValueSetter.call(element, action.value);
  } else if (element.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
    nativeTextAreaValueSetter.call(element, action.value);
  } else {
    element.value = action.value;
  }

  // Dispatch events for React/Vue/controlled inputs if supported
  if (typeof element.dispatchEvent === 'function' && typeof Event !== 'undefined') {
    try {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }

  return { success: true };
}

/**
 * Execute a scroll action.
 * Bounded scroll operation.
 */
function executeScroll(action, currentGeneration) {
  if (action.target) {
    // Scroll to specific element
    const element = window.SIH_ElementRegistry ? window.SIH_ElementRegistry.resolve(action.target, currentGeneration) : null;
    if (!element) {
      return { success: false, error: `Scroll target not found: ${action.target}` };
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    // Scroll page by value or default
    const amount = parseInt(action.value) || 300;
    // Bound the scroll amount
    const bounded = Math.max(-2000, Math.min(2000, amount));
    window.scrollBy({ top: bounded, behavior: 'smooth' });
  }

  return { success: true };
}

// Expose for content.js & test environments
if (typeof window !== 'undefined') {
  window.SIH_Executor = { executeAction };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { executeAction, executeClick, executeType, executeScroll };
}
