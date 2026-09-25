/**
 * Sanitizer — SIH26171 Phase 1
 * 
 * Takes raw browser context + Detection[] → SanitizedContext
 * 
 * Invariant: No raw PII may exist anywhere inside a SanitizedContext.
 * 
 * Replaces detected PII values with placeholder tokens.
 * Maintains device-local mapping for potential reverse lookup.
 * Source-agnostic: does not depend on which detector produced the detection.
 */

/**
 * Sanitizer state — device-local only.
 * Maps placeholder tokens to original values.
 * NEVER crosses network boundary.
 */
const SIH_SanitizerState = {
  _counter: {},
  _mapping: {},      // token → raw value
  _reverseMapping: {}, // raw value → token
  _metadata: {},     // token → safe detector metadata
  
  reset() {
    this._counter = {};
    this._mapping = {};
    this._reverseMapping = {};
    this._metadata = {};
  },
  
  /**
   * Get or create a placeholder token for a detected PII value.
   */
  getToken(type, rawValue, metadata) {
    if (!rawValue || !rawValue.trim()) return '';
    
    // Check if already mapped
    const existing = this._reverseMapping[rawValue];
    if (existing) return existing;
    
    // Create new token
    const typeKey = (type || 'SENSITIVE').toUpperCase().replace('_FIELD', '');
    if (!this._counter[typeKey]) this._counter[typeKey] = 0;
    this._counter[typeKey]++;
    
    const token = `[${typeKey}_${this._counter[typeKey]}]`;
    this._mapping[token] = rawValue;
    this._reverseMapping[rawValue] = token;
    if (metadata) this._metadata[token] = { ...metadata };
    
    return token;
  },
  
  /**
   * Get the full mapping (device-local use only).
   */
  getMapping() {
    return { ...this._mapping };
  },
  
  /**
   * Get detections with their tokens for privacy visualization.
   */
  getDetectionSummary() {
    const summary = [];
    for (const token of Object.keys(this._mapping)) {
      summary.push({ token, ...(this._metadata[token] || {}) });
    }
    return summary;
  }
};

/**
 * Sanitize a text string by replacing all detected PII values with tokens.
 */
function sanitizeText(text, detections) {
  if (!text) return '';
  
  let sanitized = text;
  
  // Sort detections by value length (longest first) to avoid partial replacements
  const sorted = [...detections]
    .filter(d => d.value && d.value.trim())
    .sort((a, b) => (b.value || '').length - (a.value || '').length);
  
  for (const detection of sorted) {
    if (!detection.value) continue;
    const token = SIH_SanitizerState.getToken(detection.type, detection.value);
    // Replace all occurrences of the raw value
    while (sanitized.includes(detection.value)) {
      sanitized = sanitized.replace(detection.value, token);
    }
  }
  
  return sanitized;
}

/**
 * Extract visible page elements for the context.
 * Returns sanitized element descriptors.
 */
function extractPageElements(detections) {
  const elements = [];
  const processedElements = new Set();
  
  // Prune disconnected elements before extraction
  if (typeof window.SIH_ElementRegistry !== 'undefined') {
    window.SIH_ElementRegistry.prune();
  }
  
  // Collect interactive/important elements
  const selectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
  const domElements = document.querySelectorAll(selectors);
  
  domElements.forEach((el) => {
    if (typeof window.SIH_DomDetector !== 'undefined' && !window.SIH_DomDetector.isElementVisible(el)) return;
    if (processedElements.has(el)) return;
    processedElements.add(el);
    
    const id = (typeof window.SIH_ElementRegistry !== 'undefined')
      ? window.SIH_ElementRegistry.register(el)
      : (el.id || el.name || `el_${el.tagName.toLowerCase()}`);
    if (!id) return;
    
    let text = el.textContent ? el.textContent.trim().substring(0, 200) : '';
    let label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    
    // Sanitize text and label
    text = sanitizeText(text, detections);
    label = sanitizeText(label, detections);
    
    elements.push({
      id: id,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      text: text || undefined,
      label: label || undefined
    });
  });
  
  return elements;
}

/**
 * Get visible page text content (sanitized).
 */
function getVisiblePageText(detections) {
  // Gather visible text
  let pageText = '';
  if (typeof window.SIH_RegexDetector !== 'undefined') {
    const textNodes = window.SIH_RegexDetector.getVisibleTextContent();
    pageText = textNodes.map(n => n.text.trim()).filter(Boolean).join('\n');
  } else {
    pageText = document.body ? document.body.innerText.substring(0, 5000) : '';
  }
  
  // Sanitize the full text
  return sanitizeText(pageText, detections);
}

/**
 * Build SanitizedContext from raw page + Detection[].
 * This is the ONLY object that may cross the network boundary.
 * 
 * @param {Detection[]} detections - Combined detections from all sources
 * @param {string|null} redactedScreenshot - Base64 redacted screenshot (optional)
 * @returns {SanitizedContext}
 */
function buildSanitizedContext(detections, redactedScreenshot) {
  // Reset sanitizer state for fresh context
  SIH_SanitizerState.reset();
  
  // Pre-register all detection tokens
  for (const d of detections) {
    if (d.value) {
      const token = SIH_SanitizerState.getToken(d.type, d.value);
      SIH_SanitizerState._metadata[token] = {
        type: d.type,
        source: d.source,
        confidence: d.confidence
      };
    }
  }
  
  // Build sanitized page text
  const sanitizedText = getVisiblePageText(detections);
  
  // Build sanitized elements
  const sanitizedElements = extractPageElements(detections);
  
  // Sanitize page title
  const rawTitle = document.title || '';
  const sanitizedTitle = sanitizeText(rawTitle, detections);
  
  const context = {
    page: {
      url: window.location.href,
      title: sanitizedTitle
    },
    elements: sanitizedElements,
    text: sanitizedText.substring(0, 8000), // Limit text size
    screenshot: redactedScreenshot || undefined
  };
  
  return context;
}

// Expose for content.js
if (typeof window !== 'undefined') {
  window.SIH_Sanitizer = {
    buildSanitizedContext,
    sanitizeText,
    SIH_SanitizerState
  };
}
