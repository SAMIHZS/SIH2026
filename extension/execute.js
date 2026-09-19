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
 * @param {Action} action - The validated action to execute
 * @returns {{ success: boolean, error?: string }}
 */
function executeAction(action) {
  try {
    switch (action.action) {
      case 'click':
        return executeClick(action);
      case 'type':
        return executeType(action);
      case 'scroll':
        return executeScroll(action);
      default:
        return { success: false, error: `Unknown action type: ${action.action}` };
    }
  } catch (err) {
    return { success: false, error: `Execution error: ${err.message}` };
  }
}

/**
 * Execute a click action.
 */
function executeClick(action) {
  const element = document.querySelector(action.target);
  if (!element) {
    return { success: false, error: `Click target not found: ${action.target}` };
  }
  
  // Scroll into view first
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  
  // Small delay to let scroll complete, then click
  setTimeout(() => {
    element.click();
  }, 100);
  
  return { success: true };
}

/**
 * Execute a type action.
 * Handles React/Vue/controlled inputs by dispatching synthetic events.
 */
function executeType(action) {
  const element = document.querySelector(action.target);
  if (!element) {
    return { success: false, error: `Type target not found: ${action.target}` };
  }
  
  // Focus the element
  element.focus();
  
  // Set value
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set;
  const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;
  
  if (element.tagName === 'INPUT' && nativeInputValueSetter) {
    nativeInputValueSetter.call(element, action.value);
  } else if (element.tagName === 'TEXTAREA' && nativeTextAreaValueSetter) {
    nativeTextAreaValueSetter.call(element, action.value);
  } else {
    element.value = action.value;
  }
  
  // Dispatch events for React/Vue/controlled inputs
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  
  return { success: true };
}

/**
 * Execute a scroll action.
 * Bounded scroll operation.
 */
function executeScroll(action) {
  if (action.target) {
    // Scroll to specific element
    const element = document.querySelector(action.target);
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

// Expose for content.js
if (typeof window !== 'undefined') {
  window.SIH_Executor = { executeAction };
}
