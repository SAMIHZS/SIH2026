/**
 * Structured Logger — SIH26171
 * 
 * Centralized logging module that enforces structured categories
 * and sanitizes sensitive data before outputting to the console.
 */
(function() {
  'use strict';

  const CATEGORIES = new Set([
    'LIFECYCLE',
    'CONTEXT',
    'PERCEPTION',
    'OCR',
    'VISION',
    'PRIVACY',
    'MODEL',
    'ACTION',
    'SECURITY',
    'SIDEBAR',
    'ERROR'
  ]);

  function sanitizeLogData(data) {
    if (data === null || data === undefined) return data;
    
    // Mask sensitive string patterns
    if (typeof data === 'string') {
      if (data.startsWith('data:image/')) return '[REDACTED_IMAGE_DATA]';
      if (data.includes('sk-') || /^[A-Za-z0-9_-]{30,}$/.test(data)) return '[REDACTED_KEY]';
      // Basic PII masking (just in case it slipped past primary sanitizer)
      let masked = data.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]');
      masked = masked.replace(/(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/g, '[PHONE]');
      return masked;
    }

    // Shallow clone and sanitize objects
    if (typeof data === 'object') {
      if (Array.isArray(data)) {
        return data.map(item => typeof item === 'object' ? '{...}' : sanitizeLogData(item));
      }
      
      const safeObj = {};
      for (const [key, value] of Object.entries(data)) {
        if (key.toLowerCase().includes('password') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('apikey')) {
          safeObj[key] = '[REDACTED]';
        } else if (key === 'screenshot' || key === 'dataUrl') {
          safeObj[key] = value ? '[REDACTED_IMAGE_DATA]' : null;
        } else if (typeof value === 'object' && value !== null) {
          safeObj[key] = '{...}'; // Avoid deep cloning
        } else {
          safeObj[key] = sanitizeLogData(value);
        }
      }
      return safeObj;
    }

    return data;
  }

  function log(category, message, data = null) {
    if (!CATEGORIES.has(category)) {
      category = 'LIFECYCLE'; // fallback
    }

    const prefix = `[SIH][${category}]`;
    const safeData = data ? sanitizeLogData(data) : '';
    
    if (category === 'ERROR') {
      console.error(prefix, message, safeData);
    } else if (category === 'SECURITY' || category === 'PRIVACY') {
      console.warn(prefix, message, safeData);
    } else {
      console.info(prefix, message, safeData !== '' ? safeData : '');
    }
  }

  function error(subsystem, operation, err, meta = {}) {
    log('ERROR', `subsystem=${subsystem} operation=${operation} reason=${err.message || err}`, { ...meta, errorClass: err.name });
  }

  const logger = { log, error, sanitizeLogData };

  if (typeof window !== 'undefined') {
    window.SIH_Logger = logger;
  }
  if (typeof self !== 'undefined' && typeof window === 'undefined') {
    self.SIH_Logger = logger;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = logger;
  }
})();
