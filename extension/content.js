/**
 * Content Script — SIH26171 Phase 1 & 2
 * 
 * Orchestrates the privacy pipeline on each page:
 * 1. Automatically observes the page (no Analyze button)
 * 2. Robust, bounded analysis scheduler (resistant to continuous mutations)
 * 3. Concurrency lock: runs only one analysis at a time, queues pending pass
 * 4. Stale-result protection with generation tokens
 * 5. Runs DOM + Regex detectors → Detection[]
 * 6. Sanitizes → SanitizedContext
 * 7. Communicates with service worker via chrome.runtime messaging
 * 8. Receives and executes validated actions
 * 
 * The content script does NOT do cross-origin networking.
 * The service worker owns backend communication.
 */

(function() {
  'use strict';
  
  // ── State ──
  let isEnabled = true;
  let currentDetections = [];
  let activeAnalysisDetections = null;
  let currentSanitizedContext = null;
  let latestMetrics = null;
  let latestGateDecision = null;
  let lastProcessedUrl = '';
  let lastProcessedHash = '';

  // ── Analysis Scheduler State Machine ──
  // States: 'IDLE' | 'SCHEDULED' | 'RUNNING'
  let analysisState = 'IDLE';
  let analysisPending = false;
  let currentAnalysisGeneration = 0;
  let debounceTimer = null;
  let maxWaitTimer = null;
  let firstScheduledTime = 0;
  let observerTriggerCount = 0;
  let pendingResolvers = [];

  const DEBOUNCE_MS = 1500;  // Settling debounce window for bursts
  const MAX_WAIT_MS = 3000;  // Strict bound preventing starvation under continuous mutations
  
  // ── Observers & SPA Nav State ──
  let mutationObserver = null;
  let popstateHandler = null;

  // ── Initialization ──
  
  /**
   * Initialize the content script.
   */
  function init() {
    // Configure legacy MediaPipe loader (for visionDetector.js compatibility shim)
    window.SIH_MediaPipeLoader?.configure();
    // Load enabled state from storage
    chrome.storage.local.get(['privacyEnabled'], (result) => {
      isEnabled = result.privacyEnabled !== false; // Default to enabled
      if (isEnabled) {
        // Prompt initial load settle (100ms) to ensure fast initial context
        setTimeout(() => {
          requestAnalysis({ immediate: false });
        }, 100);
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
          requestAnalysis({ immediate: false });
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
      case 'VISUAL_DIAGNOSTIC':
        // Diagnostics forwarded from background worker — render in page console
        if (window.SIH_VisualPipeline?.handleWorkerDiagnostic) {
          window.SIH_VisualPipeline.handleWorkerDiagnostic(message.stage, message.data || {});
        }
        return false;

      case 'SYNC_GENERATION':
        if (typeof message.generation === 'number') {
          currentAnalysisGeneration = message.generation;
          window.SIH_ElementRegistry?.setContextGeneration?.(currentAnalysisGeneration, window.location.href);
        }
        sendResponse({ ok: true, generation: currentAnalysisGeneration });
        return false;

      case 'GET_CONTEXT':
        console.info(`[CONTEXT FLOW] background -> content GET_CONTEXT (tab gen=${currentAnalysisGeneration}, msg gen=${message.generation})`);
        if (typeof message.generation === 'number' && message.generation > currentAnalysisGeneration) {
          currentAnalysisGeneration = message.generation;
          window.SIH_ElementRegistry?.setContextGeneration?.(currentAnalysisGeneration, window.location.href);
        }

        // If lightweight or enriched context is already available, respond immediately
        if (currentSanitizedContext) {
          sendResponse({
            sanitizedContext: currentSanitizedContext,
            detections: currentDetections.map(d => ({
              elementId: d.elementId,
              type: d.type,
              source: d.source,
              confidence: d.confidence
            })),
            mapping: window.SIH_Sanitizer?.SIH_SanitizerState?.getDetectionSummary?.() || [],
            metrics: latestMetrics,
            gateDecision: latestGateDecision,
            generation: currentAnalysisGeneration,
            navigationIdentity: window.location.href
          });
          return false;
        }

        // If not yet available, trigger immediate lightweight analysis pass
        requestAnalysis({ immediate: true });
        waitForAnalysis().then((ctx) => {
          sendResponse({
            sanitizedContext: ctx || currentSanitizedContext,
            detections: currentDetections.map(d => ({
              elementId: d.elementId,
              type: d.type,
              source: d.source,
              confidence: d.confidence
            })),
            mapping: window.SIH_Sanitizer?.SIH_SanitizerState?.getDetectionSummary?.() || [],
            metrics: latestMetrics,
            gateDecision: latestGateDecision,
            generation: currentAnalysisGeneration,
            navigationIdentity: window.location.href
          });
        });
        return true; // Will respond async
      
      case 'EXECUTE_ACTION':
        // Validate and execute an action (strictly generation-bound)
        const action = message.action;
        const validation = window.SIH_Validator.validateAction(action, currentAnalysisGeneration);
        if (validation.allowed) {
          const result = window.SIH_Executor.executeAction(action);
          sendResponse({ success: result.success, error: result.error });
        } else {
          sendResponse({ success: false, error: `Validation failed: ${validation.reason}` });
        }
        return false;
      
      case 'GET_RECTS':
        // Return bounding rects for detected elements (for screenshot redaction)
        const activeSource = activeAnalysisDetections || currentDetections;
        const rects = activeSource
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

      case 'REDACT_SCREENSHOT':
        if (!window.SIH_Redactor) {
          sendResponse({ error: 'Local screenshot redactor unavailable' });
          return false;
        }
        window.SIH_Redactor.redactImage(message.dataUrl, message.rects || [])
          .then(redactedScreenshot => sendResponse({ redactedScreenshot }))
          .catch(error => sendResponse({ error: error.message }));
        return true;
      
      case 'TOGGLE_PRIVACY':
        isEnabled = message.enabled;
        if (isEnabled) {
          requestAnalysis({ immediate: false });
          setupObservers();
        } else {
          teardownObservers();
        }
        sendResponse({ ok: true });
        return false;
      
      case 'PING':
        sendResponse({ ok: true, state: analysisState, generation: currentAnalysisGeneration });
        return false;
      
      default:
        return false;
    }
  }

  // ── Scheduler & Concurrency Control ──

  function notifyCompletion(result) {
    const resolvers = pendingResolvers;
    pendingResolvers = [];
    for (const resolve of resolvers) {
      try { resolve(result); } catch (e) { /* ignore */ }
    }
  }

  function waitForAnalysis() {
    if (analysisState === 'IDLE' && !analysisPending && currentSanitizedContext) {
      return Promise.resolve(currentSanitizedContext);
    }
    return new Promise(resolve => {
      pendingResolvers.push(resolve);
    });
  }

  function clearSchedulingTimers() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  /**
   * Request page analysis.
   * - Enforces bounded debounce (at most MAX_WAIT_MS under continuous mutations).
   * - Sets analysisPending = true if an analysis is currently running.
   */
  function requestAnalysis(options = {}) {
    const immediate = Boolean(options.immediate);
    observerTriggerCount++;

    if (!isEnabled) return;

    if (analysisState === 'RUNNING') {
      // An analysis is actively executing: queue a pending pass
      analysisPending = true;
      return;
    }

    if (immediate) {
      clearSchedulingTimers();
      triggerRun();
      return;
    }

    if (analysisState === 'IDLE') {
      analysisState = 'SCHEDULED';
      firstScheduledTime = performance.now();

      debounceTimer = setTimeout(() => {
        clearSchedulingTimers();
        triggerRun();
      }, DEBOUNCE_MS);

      maxWaitTimer = setTimeout(() => {
        clearSchedulingTimers();
        triggerRun();
      }, MAX_WAIT_MS);
      return;
    }

    if (analysisState === 'SCHEDULED') {
      // Continuous mutation: reset debounceTimer, but preserve maxWaitTimer
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        clearSchedulingTimers();
        triggerRun();
      }, DEBOUNCE_MS);
    }
  }

  function triggerRun() {
    if (!isEnabled) {
      analysisState = 'IDLE';
      return;
    }

    if (analysisState === 'RUNNING') {
      analysisPending = true;
      return;
    }

    analysisState = 'RUNNING';
    const generation = ++currentAnalysisGeneration;
    const triggers = observerTriggerCount;
    observerTriggerCount = 0;

    runAnalysis(generation, triggers);
  }
  
  // ── Analysis Pipeline ──
  
  /**
   * Run the full analysis pipeline with generation token protection.
   * DOM + Regex detection → Sanitization → SanitizedContext
   */
  async function runAnalysis(generation, triggerCount = 0) {
    const startMs = performance.now();
    const metrics = window.SIH_Metrics ? window.SIH_Metrics.createMetrics() : null;
    
    // Scopes element registrations to the current page analysis generation
    window.SIH_ElementRegistry?.setContextGeneration?.(generation, window.location.href);
    
    console.info(`[SIH][analysis ${generation}] start (coalesced triggers: ${triggerCount})`);
    
    try {
      // 1. Run DOM detector
      const domDetections = metrics
        ? window.SIH_Metrics.measure(metrics, 'domMs', () => window.SIH_DomDetector.runDomDetector())
        : window.SIH_DomDetector.runDomDetector();
      console.info(`[SIH][analysis ${generation}] DOM ${metrics?.domMs?.toFixed(1) || 0}ms (${domDetections.length} dets)`);
      
      // Stale check
      if (generation !== currentAnalysisGeneration) {
        console.warn(`[SIH][analysis ${generation}] superseded after DOM stage; discarding`);
        return;
      }

      // 2. Run regex detector
      const regexDetections = metrics
        ? window.SIH_Metrics.measure(metrics, 'regexMs', () => window.SIH_RegexDetector.runRegexDetector())
        : window.SIH_RegexDetector.runRegexDetector();
      console.info(`[SIH][analysis ${generation}] Regex ${metrics?.regexMs?.toFixed(1) || 0}ms (${regexDetections.length} dets)`);
      
      // Stale check
      if (generation !== currentAnalysisGeneration) {
        console.warn(`[SIH][analysis ${generation}] superseded after Regex stage; discarding`);
        return;
      }

      // 3. Fuse detections while preserving detector provenance.
      const allDetections = [...domDetections, ...regexDetections];
      const fusedDetections = metrics && window.SIH_DetectionFusion
        ? window.SIH_Metrics.measure(metrics, 'fusionMs', () => window.SIH_DetectionFusion.fuse(allDetections))
        : mergeDetections(domDetections, regexDetections);
      console.info(`[SIH][analysis ${generation}] Fusion ${metrics?.fusionMs?.toFixed(1) || 0}ms (${fusedDetections.length} dets)`);

      // 4. Decide whether visual stages are justified.
      const gateInput = {
        detections: fusedDetections,
        imageCount: document.images ? document.images.length : 0,
        canvasCount: document.querySelectorAll('canvas').length,
        // Consider page image-heavy even with 1 image (for face detection)
        imageHeavy: Boolean(document.images && document.images.length > 0),
        ocrAvailable: window.SIH_OcrDetector ? window.SIH_OcrDetector.isAvailable() : false,
        // Use SIH_VisualPipeline (new worker-based) as the CV availability signal
        cvAvailable: Boolean(window.SIH_VisualPipeline && window.SIH_VisualPipeline.isAvailable())
      };
      const gateDecision = window.SIH_DetectionGate
        ? (metrics
          ? window.SIH_Metrics.measure(metrics, 'gateMs', () => window.SIH_DetectionGate.decide(gateInput))
          : window.SIH_DetectionGate.decide(gateInput))
        : null;

      console.info(`[SIH][analysis ${generation}] Gate OCR=${Boolean(gateDecision?.runOcr)} CV=${Boolean(gateDecision?.runCv)}`);

      // ─────────────────────────────────────────────────────────────────
      // STAGE 1: IMMEDIATE LIGHTWEIGHT CONTEXT (PRIVACY-SAFE & FAST)
      // ─────────────────────────────────────────────────────────────────
      // Build SanitizedContext from DOM + Regex + ElementRegistry without waiting for visual models
      const lightweightContext = metrics
        ? window.SIH_Metrics.measure(metrics, 'sanitizeMs', () => window.SIH_Sanitizer.buildSanitizedContext(fusedDetections, null))
        : window.SIH_Sanitizer.buildSanitizedContext(fusedDetections, null);

      if (generation !== currentAnalysisGeneration) {
        console.warn(`[SIH][analysis ${generation}] superseded before lightweight publish; discarding`);
        return;
      }

      currentDetections = fusedDetections;
      currentSanitizedContext = lightweightContext;
      latestGateDecision = gateDecision;
      latestMetrics = metrics && window.SIH_Metrics.finish(metrics);
      lastProcessedUrl = window.location.href;
      lastProcessedHash = computePageHash();

      // Notify any callers waiting on waitForAnalysis() (like GET_CONTEXT) immediately!
      notifyCompletion(currentSanitizedContext);

      // Notify service worker that lightweight context is ready and chat can begin immediately!
      const t_contextReady = performance.now();
      console.info(`[CONTEXT FLOW] content -> background CONTEXT_READY (lightweight gen=${generation}, total ${(t_contextReady - startMs).toFixed(1)}ms, elements=${currentSanitizedContext.elements?.length || 0})`);

      chrome.runtime.sendMessage({
        type: 'CONTEXT_READY',
        sanitizedContext: currentSanitizedContext,
        detectionCount: currentDetections.length,
        mapping: window.SIH_Sanitizer?.SIH_SanitizerState?.getDetectionSummary?.() || [],
        metrics: latestMetrics,
        gateDecision: latestGateDecision,
        url: window.location.href,
        generation,
        isLightweight: true
      }).catch(() => {});

      // ─────────────────────────────────────────────────────────────────
      // STAGE 2: ASYNCHRONOUS VISUAL PERCEPTION & ENRICHMENT
      // ─────────────────────────────────────────────────────────────────
      const visualPipelineAvailable = Boolean(window.SIH_VisualPipeline?.isAvailable());
      const shouldRunVisual = visualPipelineAvailable &&
        ((gateDecision?.runOcr || gateDecision?.runCv) || gateInput.imageCount > 0);

      if (shouldRunVisual) {
        // Run visual pipeline asynchronously in background — does NOT block chat
        runAsyncVisualEnrichment(generation, fusedDetections, gateDecision, metrics);
      } else if (!shouldRunVisual && gateDecision?.runOcr && window.SIH_OcrDetector?.isAvailable()) {
        runLegacyOcr(metrics).then((legacyOcrResult) => {
          if (generation !== currentAnalysisGeneration) return;
          if (legacyOcrResult.detections.length > 0) {
            currentDetections = window.SIH_DetectionFusion
              ? window.SIH_DetectionFusion.fuse([...currentDetections, ...legacyOcrResult.detections])
              : [...currentDetections, ...legacyOcrResult.detections];
            currentSanitizedContext = window.SIH_Sanitizer.buildSanitizedContext(currentDetections, null);
            chrome.runtime.sendMessage({
              type: 'CONTEXT_READY',
              sanitizedContext: currentSanitizedContext,
              detectionCount: currentDetections.length,
              mapping: window.SIH_Sanitizer?.SIH_SanitizerState?.getDetectionSummary?.() || [],
              metrics: latestMetrics,
              gateDecision: latestGateDecision,
              url: window.location.href,
              generation,
              isEnriched: true
            }).catch(() => {});
          }
        });
      }
      
    } catch (err) {
      console.error(`[SIH][analysis ${generation}] error:`, err?.message || err);
      notifyCompletion(null);
    } finally {
      if (generation === currentAnalysisGeneration) {
        activeAnalysisDetections = null;
        analysisState = 'IDLE';
        if (analysisPending) {
          analysisPending = false;
          console.info(`[SIH] Scheduling queued pending analysis after generation ${generation}`);
          requestAnalysis({ immediate: false });
        }
      }
    }
  }

  /**
   * Legacy OCR path — used only when the VisualPipeline worker is unavailable
   * (e.g. test environments, file:// origin).
   * Does NOT produce a sanitized screenshot.
   */
  async function runLegacyOcr(metrics) {
    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_FOR_ANALYSIS' }, resolve);
    });
    if (!response?.screenshot) {
      return { available: false, detections: [], reason: response?.error || 'Screenshot unavailable' };
    }
    const options = {
      bbox: { x: window.scrollX || 0, y: window.scrollY || 0, width: window.innerWidth, height: window.innerHeight },
      elementId: 'visual_viewport'
    };
    try {
      const result = metrics
        ? await window.SIH_Metrics.measureAsync(metrics, 'ocrMs', () => window.SIH_OcrDetector.recognize(response.screenshot, options))
        : await window.SIH_OcrDetector.recognize(response.screenshot, options);
      if (metrics && result.timings) {
        metrics.ocrInitMs = result.timings.ocrInitMs || 0;
        metrics.ocrMs = result.timings.ocrMs || metrics.ocrMs;
      }
      // NOTE: screenshot itself is NOT returned here — raw screenshots stay in the worker pipeline
      return { ...result };
    } catch (error) {
      if (metrics) window.SIH_Metrics.recordFailure(metrics, 'ocrMs', error);
      return { available: false, detections: [], reason: error.message };
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
  
  /**
   * Set up observers for page changes.
   * Idempotent: clears previous observers, listeners, and intervals first.
   */
  function setupObservers() {
    teardownObservers();
    
    // 1. MutationObserver with intelligent element filtering
    mutationObserver = new MutationObserver((mutations) => {
      const significant = mutations.some(m => {
        const target = m.target;
        if (target && target.nodeType === 1) {
          // Ignore mutations inside extension-protected elements
          if (target.hasAttribute?.('data-sih-protected') || target.hasAttribute?.('data-sih-ignore') || target.id?.startsWith('sih-')) {
            return false;
          }
        }
        if (m.type === 'childList') {
          const hasSignificantNode = (nodeList) => {
            for (let i = 0; i < nodeList.length; i++) {
              const node = nodeList[i];
              if (node.nodeType === 1) {
                const tag = node.tagName.toLowerCase();
                // Filter out non-content structural nodes
                if (['script', 'style', 'link', 'noscript'].includes(tag)) continue;
                if (node.hasAttribute?.('data-sih-protected') || node.hasAttribute?.('data-sih-ignore') || node.id?.startsWith('sih-')) continue;
                return true;
              }
              if (node.nodeType === 3 && node.textContent.trim().length > 0) {
                return true;
              }
            }
            return false;
          };
          return hasSignificantNode(m.addedNodes) || hasSignificantNode(m.removedNodes);
        }
        if (m.type === 'attributes') {
          return ['value', 'type', 'name', 'placeholder', 'aria-label'].includes(m.attributeName);
        }
        return false;
      });
      
      if (significant) {
        requestAnalysis();
      }
    });
    
    const targetNode = document.body || document.documentElement;
    if (targetNode) {
      mutationObserver.observe(targetNode, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['value', 'type', 'name', 'placeholder', 'aria-label']
      });
    }
    
    // 2. SPA navigation listener via popstate
    popstateHandler = () => {
      requestAnalysis({ immediate: true });
    };
    window.addEventListener('popstate', popstateHandler);

    // 3. SPA polling fallback (cleared in teardown)
    let currentHref = window.location.href;
    const navigationCheck = setInterval(() => {
      if (window.location.href !== currentHref) {
        currentHref = window.location.href;
        requestAnalysis({ immediate: true });
      }
    }, 2000);
    
    window._sih_navCheck = navigationCheck;
  }
  
  /**
   * Tear down observers and timers cleanly.
   */
  function teardownObservers() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (popstateHandler) {
      window.removeEventListener('popstate', popstateHandler);
      popstateHandler = null;
    }
    if (window._sih_navCheck) {
      clearInterval(window._sih_navCheck);
      window._sih_navCheck = null;
    }
    clearSchedulingTimers();
    analysisState = 'IDLE';
    analysisPending = false;
  }
  
  // ── Diagnostic / Test Exposure ──
  window.SIH_Scheduler = {
    getState: () => analysisState,
    isPending: () => analysisPending,
    getGeneration: () => currentAnalysisGeneration,
    requestAnalysis,
    runAnalysis: (immediate = true) => requestAnalysis({ immediate }),
    setupObservers,
    teardownObservers,
    clearSchedulingTimers
  };

  // ── Start ──
  
  // Wait for document to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();
