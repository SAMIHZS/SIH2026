/**
 * Content Script — SIH26171 Phase 1
 * 
 * Orchestrates the privacy pipeline on each page:
 * 1. Automatically observes the page (no Analyze button)
 * 2. Runs DOM + Regex detectors → Detection[]
 * 3. Sanitizes → SanitizedContext
 * 4. Communicates with service worker via chrome.runtime messaging
 * 5. Receives and executes validated actions
 * 
 * The content script does NOT do cross-origin networking.
 * The service worker owns backend communication.
 */

(function() {
  'use strict';
  
  // ── State ──
  let isEnabled = true;
  let currentDetections = [];
  let currentSanitizedContext = null;
  let isProcessing = false;
  let lastProcessedUrl = '';
  let lastProcessedHash = '';
  let debounceTimer = null;
  const DEBOUNCE_MS = 1500; // Debounce page changes
  
  // ── Initialization ──
  
  /**
   * Initialize the content script.
   */
  function init() {
    // Load enabled state from storage
    chrome.storage.local.get(['privacyEnabled'], (result) => {
      isEnabled = result.privacyEnabled !== false; // Default to enabled
      if (isEnabled) {
        scheduleAnalysis();
        setupObservers();
      }
    });
    
    // Listen for messages from service worker / popup / sidebar
    chrome.runtime.onMessage.addListener(handleMessage);
    
    // Listen for storage changes (privacy toggle)
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.privacyEnabled) {
        isEnabled = changes.privacyEnabled.newValue !== false;
        if (isEnabled) {
          scheduleAnalysis();
          setupObservers();
        } else {
          teardownObservers();
        }
      }
    });
  }
  
  // ── Message Handling ──
  
  function handleMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'GET_CONTEXT':
        // Return current sanitized context (async)
        runAnalysis().then(() => {
          sendResponse({
            sanitizedContext: currentSanitizedContext,
            detections: currentDetections.map(d => ({
              elementId: d.elementId,
              type: d.type,
              source: d.source,
              confidence: d.confidence
              // value intentionally excluded — device-local only
            })),
            mapping: window.SIH_Sanitizer.SIH_SanitizerState.getDetectionSummary()
          });
        });
        return true; // Will respond async
      
      case 'EXECUTE_ACTION':
        // Validate and execute an action
        const action = message.action;
        const validation = window.SIH_Validator.validateAction(action);
        if (validation.allowed) {
          const result = window.SIH_Executor.executeAction(action);
          sendResponse({ success: result.success, error: result.error });
        } else {
          sendResponse({ success: false, error: `Validation failed: ${validation.reason}` });
        }
        return false;
      
      case 'GET_RECTS':
        // Return bounding rects for detected elements (for screenshot redaction)
        const rects = currentDetections
          .filter(d => d.rect)
          .map(d => ({
            x: d.rect.x,
            y: d.rect.y,
            width: d.rect.width,
            height: d.rect.height,
            type: d.type
          }));
        sendResponse({ rects });
        return false;
      
      case 'TOGGLE_PRIVACY':
        isEnabled = message.enabled;
        if (isEnabled) {
          scheduleAnalysis();
          setupObservers();
        }
        sendResponse({ ok: true });
        return false;
      
      case 'PING':
        sendResponse({ ok: true });
        return false;
      
      default:
        return false;
    }
  }
  
  // ── Analysis Pipeline ──
  
  /**
   * Run the full analysis pipeline:
   * DOM + Regex detection → Sanitization → SanitizedContext
   */
  async function runAnalysis() {
    if (isProcessing || !isEnabled) return;
    isProcessing = true;
    
    try {
      // 1. Run DOM detector
      const domDetections = window.SIH_DomDetector.runDomDetector();
      
      // 2. Run regex detector
      const regexDetections = window.SIH_RegexDetector.runRegexDetector();
      
      // 3. Merge detections (deduplicate by value where possible)
      currentDetections = mergeDetections(domDetections, regexDetections);
      
      // 4. Build SanitizedContext (no screenshot yet — will be added by service worker)
      currentSanitizedContext = window.SIH_Sanitizer.buildSanitizedContext(currentDetections, null);
      
      // 5. Notify service worker that context is ready
      chrome.runtime.sendMessage({
        type: 'CONTEXT_READY',
        sanitizedContext: currentSanitizedContext,
        detectionCount: currentDetections.length,
        mapping: window.SIH_Sanitizer.SIH_SanitizerState.getDetectionSummary()
      }).catch(() => {
        // Service worker may not be ready yet
      });
      
      lastProcessedUrl = window.location.href;
      lastProcessedHash = computePageHash();
      
    } catch (err) {
      console.error('[SIH26171] Analysis error:', err);
    } finally {
      isProcessing = false;
    }
  }
  
  /**
   * Merge detections from multiple sources.
   * Deduplicates by value, keeps higher-confidence detection.
   */
  function mergeDetections(domDets, regexDets) {
    const merged = [...domDets];
    const existingValues = new Set(domDets.map(d => d.value).filter(Boolean));
    
    for (const d of regexDets) {
      // Skip if DOM already detected this exact value
      if (d.value && existingValues.has(d.value)) continue;
      merged.push(d);
      if (d.value) existingValues.add(d.value);
    }
    
    return merged;
  }
  
  /**
   * Compute a simple hash of page content for change detection.
   */
  function computePageHash() {
    const text = document.body ? document.body.innerText.substring(0, 1000) : '';
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit int
    }
    return String(hash);
  }
  
  // ── Automatic Page Observation ──
  
  let mutationObserver = null;
  
  /**
   * Schedule analysis with debounce.
   */
  function scheduleAnalysis() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runAnalysis();
    }, DEBOUNCE_MS);
  }
  
  /**
   * Set up observers for page changes.
   */
  function setupObservers() {
    // Mutation observer for dynamic DOM changes
    if (mutationObserver) mutationObserver.disconnect();
    
    mutationObserver = new MutationObserver((mutations) => {
      // Filter out trivial mutations
      const significant = mutations.some(m => {
        if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) return true;
        if (m.type === 'attributes' && ['value', 'type', 'name', 'placeholder'].includes(m.attributeName)) return true;
        return false;
      });
      
      if (significant) {
        scheduleAnalysis();
      }
    });
    
    mutationObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['value', 'type', 'name', 'placeholder', 'aria-label']
    });
    
    // SPA navigation detection
    let currentHref = window.location.href;
    const navigationCheck = setInterval(() => {
      if (window.location.href !== currentHref) {
        currentHref = window.location.href;
        scheduleAnalysis();
      }
    }, 2000);
    
    // Store for cleanup
    window._sih_navCheck = navigationCheck;
  }
  
  /**
   * Tear down observers.
   */
  function teardownObservers() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (window._sih_navCheck) {
      clearInterval(window._sih_navCheck);
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  }
  
  // ── Start ──
  
  // Wait for document to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
