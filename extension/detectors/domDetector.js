/**
 * DOM Detector — SIH26171 Phase 1
 * 
 * Inspects DOM element attributes to detect PII-containing elements.
 * Produces Detection[] conforming to frozen schema.
 * 
 * Inspects: type, name, id, placeholder, autocomplete, aria-label,
 *           associated labels, visible text, alt, title
 * 
 * Source: "dom"
 */

// Sensitive attribute patterns (lowercase matching)
const DOM_SENSITIVE_PATTERNS = {
  password: ['password', 'passwd', 'pwd', 'pass'],
  email: ['email', 'e-mail', 'mail'],
  phone: ['phone', 'tel', 'telephone', 'mobile', 'cell'],
  card: ['card', 'cc-number', 'cc-num', 'credit-card', 'debit-card', 'card-number', 'cardnumber'],
  account: ['account', 'acct', 'account-number', 'accountnumber', 'acc-no', 'accno'],
  ssn: ['ssn', 'social-security', 'socialsecurity'],
  name_field: ['fullname', 'full-name', 'firstname', 'first-name', 'lastname', 'last-name', 'surname', 'name']
};

// Autocomplete values that indicate sensitive data
const SENSITIVE_AUTOCOMPLETE = [
  'cc-number', 'cc-exp', 'cc-csc', 'cc-name', 'cc-type',
  'email', 'tel', 'tel-national', 'tel-local',
  'name', 'given-name', 'family-name', 'additional-name',
  'bday', 'sex', 'url',
  'current-password', 'new-password',
  'street-address', 'address-line1', 'address-line2',
  'postal-code', 'country'
];

/**
 * Get the associated label text for an input element.
 */
function getAssociatedLabelText(element) {
  // Check for <label for="id">
  if (element.id) {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (label) return label.textContent.trim();
  }
  // Check for wrapping <label>
  const parentLabel = element.closest('label');
  if (parentLabel) return parentLabel.textContent.trim();
  return '';
}

/**
 * Determine PII type from attribute values.
 */
function detectTypeFromAttributes(attrs) {
  const combined = Object.values(attrs).filter(Boolean).join(' ').toLowerCase();

  for (const [piiType, patterns] of Object.entries(DOM_SENSITIVE_PATTERNS)) {
    for (const pattern of patterns) {
      if (combined.includes(pattern)) {
        return piiType;
      }
    }
  }
  return null;
}

/**
 * Check if an element is visible (not hidden).
 */
function isElementVisible(el) {
  if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
    // Could be hidden via display:none or similar
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('type') === 'hidden') return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}

/**
 * Generate a stable element identifier.
 */
function getElementId(el, index) {
  if (el.id) return el.id;
  if (el.name) return `name:${el.name}`;
  const tag = el.tagName.toLowerCase();
  return `${tag}_${index}`;
}

/**
 * Get bounding rect for an element, returns null if not visible.
 */
function getElementRect(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    x: rect.x + window.scrollX,
    y: rect.y + window.scrollY,
    width: rect.width,
    height: rect.height
  };
}

/**
 * Run DOM detection on the current page.
 * Returns Detection[] (frozen schema).
 */
function runDomDetector() {
  const detections = [];
  
  // Scan inputs, selects, textareas
  const formElements = document.querySelectorAll('input, select, textarea');
  
  formElements.forEach((el, index) => {
    if (!isElementVisible(el)) return;
    
    const attrs = {
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      placeholder: el.getAttribute('placeholder') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      label: getAssociatedLabelText(el),
      title: el.getAttribute('title') || ''
    };
    
    // Check autocomplete attribute directly
    const autocompleteVal = attrs.autocomplete.toLowerCase();
    let piiType = null;
    
    if (SENSITIVE_AUTOCOMPLETE.includes(autocompleteVal)) {
      // Map autocomplete to PII type
      if (autocompleteVal.startsWith('cc-')) piiType = 'card';
      else if (autocompleteVal === 'email') piiType = 'email';
      else if (autocompleteVal.startsWith('tel')) piiType = 'phone';
      else if (['current-password', 'new-password'].includes(autocompleteVal)) piiType = 'password';
      else if (['name', 'given-name', 'family-name', 'additional-name'].includes(autocompleteVal)) piiType = 'name_field';
      else piiType = 'sensitive';
    }
    
    // Check input type
    if (!piiType) {
      const inputType = (attrs.type || '').toLowerCase();
      if (inputType === 'password') piiType = 'password';
      else if (inputType === 'email') piiType = 'email';
      else if (inputType === 'tel') piiType = 'phone';
    }
    
    // Check other attributes
    if (!piiType) {
      piiType = detectTypeFromAttributes(attrs);
    }
    
    if (piiType) {
      const elementId = getElementId(el, index);
      const rawValue = el.value || '';
      const rect = getElementRect(el);
      
      detections.push({
        elementId: elementId,
        type: piiType,
        value: rawValue || undefined, // raw value; device-local only
        source: 'dom',
        rect: rect || undefined,
        confidence: 0.9 // DOM attribute detection is high confidence
      });
    }
  });
  
  // Scan elements with potentially sensitive text content (alt, title)
  const mediaElements = document.querySelectorAll('img[alt], img[title], [title], [aria-label]');
  
  mediaElements.forEach((el, index) => {
    if (!isElementVisible(el)) return;
    
    const alt = el.getAttribute('alt') || '';
    const title = el.getAttribute('title') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';
    const combined = [alt, title, ariaLabel].join(' ');
    
    if (!combined.trim()) return;
    
    // Check if any sensitive patterns match the metadata
    const attrs = { alt, title, ariaLabel };
    const piiType = detectTypeFromAttributes(attrs);
    
    if (piiType) {
      const elementId = getElementId(el, 10000 + index);
      const rect = getElementRect(el);
      
      detections.push({
        elementId: elementId,
        type: piiType,
        value: combined.trim() || undefined,
        source: 'dom',
        rect: rect || undefined,
        confidence: 0.7 // metadata detection is slightly lower confidence
      });
    }
  });
  
  return detections;
}

// Expose for content.js
if (typeof window !== 'undefined') {
  window.SIH_DomDetector = { runDomDetector, isElementVisible, getElementRect, getElementId };
}
