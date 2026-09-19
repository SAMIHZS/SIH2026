/**
 * Regex Detector — SIH26171 Phase 1
 * 
 * Applies regex patterns to visible/relevant text content to detect PII.
 * Operates on visible text, NOT arbitrary hidden HTML.
 * Produces Detection[] conforming to frozen schema.
 * 
 * Source: "regex"
 */

// PII regex patterns
const REGEX_PATTERNS = {
  email: {
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    type: 'email',
    confidence: 0.95
  },
  phone: {
    // Matches various phone formats: +91XXXXXXXXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX, XXXXXXXXXX (10+ digits)
    pattern: /(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/g,
    type: 'phone',
    confidence: 0.85
  },
  card: {
    // Credit/debit card-like: 13-19 digits possibly separated by spaces/dashes
    pattern: /\b(?:\d[\s\-]?){13,19}\b/g,
    type: 'card',
    confidence: 0.8,
    // Additional validation: Luhn-like check for length
    validate: (match) => {
      const digits = match.replace(/[\s\-]/g, '');
      return digits.length >= 13 && digits.length <= 19 && /^\d+$/.test(digits);
    }
  },
  account: {
    // Account-like numbers: 8-20 digits (not matching phone/card patterns exactly)
    pattern: /\b\d{8,20}\b/g,
    type: 'account',
    confidence: 0.6,
    // Only match if preceded by account-related context
    contextRequired: true,
    contextPatterns: [/account/i, /acct/i, /a\/c/i, /acc\s*no/i, /account\s*(?:number|num|no|#)/i]
  },
  ssn: {
    // US SSN format: XXX-XX-XXXX
    pattern: /\b\d{3}[\-\s]\d{2}[\-\s]\d{4}\b/g,
    type: 'ssn',
    confidence: 0.85
  }
};

/**
 * Get visible text content from the page.
 * Excludes hidden elements, scripts, styles.
 */
function getVisibleTextContent() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        
        // Skip script, style, noscript
        const tag = parent.tagName.toLowerCase();
        if (['script', 'style', 'noscript', 'template'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Skip hidden elements
        if (typeof window.SIH_DomDetector !== 'undefined' && !window.SIH_DomDetector.isElementVisible(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        
        // Skip empty text
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  const textNodes = [];
  let node;
  while (node = walker.nextNode()) {
    textNodes.push({
      text: node.textContent,
      element: node.parentElement
    });
  }
  return textNodes;
}

/**
 * Get surrounding context for a text node (for context-dependent patterns).
 */
function getSurroundingContext(element, radius) {
  if (!radius) radius = 200;
  // Get nearby text content for context
  const parent = element.parentElement || element;
  const text = parent.textContent || '';
  return text.substring(0, radius);
}

/**
 * Run regex detection on visible page text.
 * Returns Detection[] (frozen schema).
 */
function runRegexDetector() {
  const detections = [];
  const textNodes = getVisibleTextContent();
  const seenValues = new Set(); // Deduplicate
  
  for (const { text, element } of textNodes) {
    for (const [name, config] of Object.entries(REGEX_PATTERNS)) {
      // Reset regex lastIndex
      config.pattern.lastIndex = 0;
      
      let match;
      while ((match = config.pattern.exec(text)) !== null) {
        const matchedValue = match[0].trim();
        
        // Skip empty matches
        if (!matchedValue) continue;
        
        // Skip if already seen this exact value
        if (seenValues.has(matchedValue)) continue;
        
        // Additional validation if defined
        if (config.validate && !config.validate(matchedValue)) continue;
        
        // Context-required patterns need surrounding text check
        if (config.contextRequired) {
          const context = getSurroundingContext(element);
          const hasContext = config.contextPatterns.some(cp => cp.test(context));
          if (!hasContext) continue;
        }
        
        seenValues.add(matchedValue);
        
        // Try to get bounding rect of parent element
        let rect = null;
        if (element && typeof window.SIH_DomDetector !== 'undefined') {
          rect = window.SIH_DomDetector.getElementRect(element) || null;
        }
        
        const elementId = element ?
          (typeof window.SIH_DomDetector !== 'undefined' ? 
            window.SIH_DomDetector.getElementId(element, detections.length + 5000) :
            `regex_${detections.length}`) :
          `regex_${detections.length}`;
        
        detections.push({
          elementId: elementId,
          type: config.type,
          value: matchedValue, // raw value; device-local only
          source: 'regex',
          rect: rect || undefined,
          confidence: config.confidence
        });
      }
    }
  }
  
  return detections;
}

// Expose for content.js
if (typeof window !== 'undefined') {
  window.SIH_RegexDetector = { runRegexDetector, getVisibleTextContent };
}
