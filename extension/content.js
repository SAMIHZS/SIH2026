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

  function getSanitizedPageUrl() {
    try {
      if (window.location.origin && window.location.origin !== 'null') {
        return window.location.origin + (window.location.pathname || '');
      }
      return window.location.href ? window.location.href.split('?')[0].split('#')[0] : '';
    } catch (e) {
      return '';
    }
  }

  const DEBOUNCE_MS = 1500;  // Settling debounce window for bursts
  const MAX_WAIT_MS = 3000;  // Strict bound preventing starvation under continuous mutations

  // ── Observers & SPA Nav State ──
  let mutationObserver = null;
  let popstateHandler = null;
  let currentTabId = null;

  // ── Initialization ──

  console.info('[SIH][CONTENT LIFE] content.js loaded');

  // Register listener synchronously as early as possible
  chrome.runtime.onMessage.addListener(handleMessage);
  console.info('[SIH][CONTENT LIFE] runtime listener registered');

  /**
   * Initialize the content script.
   */
  function init() {
    console.info('[SIH][CONTENT LIFE] initialization started');
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

    console.info('[SIH][CONTENT LIFE] initialization completed');
  }

  // ── Message Handling ──

  function handleMessage(message, sender, sendResponse) {
    if (typeof message?.tabId === 'number') {
      currentTabId = message.tabId;
    }

    switch (message.type) {
      case 'VISUAL_DIAGNOSTIC':
        // Diagnostics forwarded from background worker — render in page console
        if (window.SIH_VisualPipeline?.handleWorkerDiagnostic) {
          window.SIH_VisualPipeline.handleWorkerDiagnostic(message.stage, message.data || {});
        }
        return false;

      case 'GET_CONTEXT':
        console.info('[SIH][CONTENT LIFE] GET_CONTEXT received');
        if (window.SIH_Logger) {
          window.SIH_Logger.log('CTX TRACE 06', 'content received GET_CONTEXT');
          window.SIH_Logger.log('CONTEXT', `background -> content GET_CONTEXT (tab gen=${currentAnalysisGeneration}, msg gen=${message.generation})`);
        }
        if (typeof message.generation === 'number' && message.generation !== currentAnalysisGeneration) {
          if (window.SIH_Logger) {
            window.SIH_Logger.log('CTX TRACE 07', 'generation adopted');
            window.SIH_Logger.log('GEN', `content adopted generation=${message.generation} (was ${currentAnalysisGeneration})`);
          }
          currentAnalysisGeneration = message.generation;
          window.SIH_ElementRegistry?.setContextGeneration?.(currentAnalysisGeneration, window.location.href);
        }

        // If force refresh requested, clear cached context
        if (message.forceRefresh) {
          currentSanitizedContext = null;
          analysisState = 'IDLE'; // Ensure we can run again immediately
        }

        // If lightweight or enriched context is already available, emit CONTEXT_READY immediately
        if (currentSanitizedContext) {
          chrome.runtime.sendMessage({
            type: 'CONTEXT_READY',
            sanitizedContext: currentSanitizedContext,
            detectionCount: currentDetections.length,
            mapping: window.SIH_Sanitizer?.SIH_SanitizerState?.getDetectionSummary?.() || [],
            metrics: latestMetrics,
            gateDecision: latestGateDecision,
            url: getSanitizedPageUrl(),
            generation: currentAnalysisGeneration,
            isLightweight: true // It could be enriched, but we flag true to satisfy the background lock quickly
          }).catch(() => {});

          sendResponse({ ok: true });
          return false;
        }

        // If not yet available, trigger immediate lightweight analysis pass
        requestAnalysis({ immediate: true });

        // We do not need to wait here because runAnalysis will emit CONTEXT_READY when done.
        // We just acknowledge receipt of GET_CONTEXT.
        sendResponse({ ok: true });
        return false;

      case 'EXECUTE_ACTION': {
        // Validate and execute an action (strictly generation-bound & tab-bound)
        const action = message.actionPayload || message.action;
        let resolvedAction = action;
        const expectedTabId = (typeof message.tabId === 'number') ? message.tabId : currentTabId;

        // Resolve semantic intent via SIH_Grounding if available
        if (window.SIH_Grounding && action) {
          const resp = window.SIH_Grounding.validateModelResponse(action, currentAnalysisGeneration, expectedTabId);
          if (!resp.valid) {
            sendResponse({ success: false, error: `Validation failed: ${resp.error}` });
            return false;
          }
          if (resp.actions && resp.actions.length > 0) {
            resolvedAction = resp.actions[0];
          }
        }

        const validation = window.SIH_Validator.validateAction(resolvedAction, currentAnalysisGeneration, expectedTabId);
        if (validation.allowed) {
          const result = window.SIH_Executor.executeAction(resolvedAction, currentAnalysisGeneration);
          sendResponse({ success: result.success, error: result.error });
        } else {
          sendResponse({ success: false, error: `Validation failed: ${validation.reason}` });
        }
        return false;
      }

      case 'QUERY_GROUNDING': {
        const gen = message.generation ?? currentAnalysisGeneration;
        if (!window.SIH_Grounding) {
          sendResponse({ ok: false, error: 'SIH_Grounding not loaded' });
          return false;
        }
        if (message.query === 'inventory') {
          const inv = window.SIH_Grounding.buildGroundedInventory(gen);
          sendResponse({ ok: true, inventory: inv });
        } else if (message.query === 'groundIntent') {
          const res = window.SIH_Grounding.groundIntent(message.intent, gen, message.tabId);
          sendResponse({ ok: true, result: res });
        } else if (message.query === 'validateModelResponse') {
          const res = window.SIH_Grounding.validateModelResponse(message.payload, gen, message.tabId);
          sendResponse({ ok: true, result: res });
        } else if (message.query === 'correlateOcr') {
          const res = window.SIH_Grounding.correlateOcrWithDom(message.ocrDetections, gen);
          sendResponse({ ok: true, correlations: res });
        } else {
          sendResponse({ ok: false, error: 'Unknown query' });
        }
        return false;
      }

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
      notifyCompletion(null);
      return;
    }

    if (analysisState === 'RUNNING') {
      analysisPending = true;
      return;
    }

    analysisState = 'RUNNING';
    // Use the generation provided by the background script, do not invent our own
    const generation = currentAnalysisGeneration;
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
    if (window.SIH_Logger) {
      window.SIH_Logger.log('CTX TRACE 08', 'analysis started');
      window.SIH_Logger.log('CONTEXT', `build started generation=${generation}`);
    }

    try {
      // 1. Run DOM detector
      if (window.SIH_Logger) window.SIH_Logger.log('DOM', `started`);
      const domDetections = metrics
        ? window.SIH_Metrics.measure(metrics, 'domMs', () => window.SIH_DomDetector.runDomDetector())
        : window.SIH_DomDetector.runDomDetector();
      if (window.SIH_Logger) {
        window.SIH_Logger.log('CTX TRACE 09', 'DOM completed');
        window.SIH_Logger.log('DOM', `completed`, { findings: domDetections.length, durationMs: metrics?.domMs?.toFixed(1) || 0 });
      }
      console.info(`[SIH][analysis ${generation}] DOM ${metrics?.domMs?.toFixed(1) || 0}ms (${domDetections.length} dets)`);

      // Stale check
      if (generation !== currentAnalysisGeneration) {
        console.warn(`[SIH][analysis ${generation}] superseded after DOM stage; discarding`);
        return;
      }

      // 2. Run regex detector
      if (window.SIH_Logger) window.SIH_Logger.log('REGEX', `started`);
      const regexDetections = metrics
        ? window.SIH_Metrics.measure(metrics, 'regexMs', () => window.SIH_RegexDetector.runRegexDetector())
        : window.SIH_RegexDetector.runRegexDetector();
      if (window.SIH_Logger) {
        window.SIH_Logger.log('CTX TRACE 10', 'Regex completed');
        window.SIH_Logger.log('REGEX', `completed`, { findings: regexDetections.length, durationMs: metrics?.regexMs?.toFixed(1) || 0 });
      }
      console.info(`[SIH][analysis ${generation}] Regex ${metrics?.regexMs?.toFixed(1) || 0}ms (${regexDetections.length} dets)`);

      // Stale check
      if (generation !== currentAnalysisGeneration) {
        console.warn(`[SIH][analysis ${generation}] superseded after Regex stage; discarding`);
        return;
      }

      // 3. Fuse detections while preserving detector provenance.
      if (window.SIH_Logger) window.SIH_Logger.log('FUSION', `started`, { dom: domDetections.length, regex: regexDetections.length });
      const allDetections = [...domDetections, ...regexDetections];
      const fusedDetections = metrics && window.SIH_DetectionFusion
        ? window.SIH_Metrics.measure(metrics, 'fusionMs', () => window.SIH_DetectionFusion.fuse(allDetections))
        : mergeDetections(domDetections, regexDetections);
      if (window.SIH_Logger) {
        window.SIH_Logger.log('CTX TRACE 11', 'Fusion completed');
        window.SIH_Logger.log('FUSION', `completed`, { inputFindings: allDetections.length, mergedFindings: fusedDetections.length, durationMs: metrics?.fusionMs?.toFixed(1) || 0 });
      }
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

      if (window.SIH_Logger) {
        window.SIH_Logger.log('GATE', `OCR`, { status: gateDecision?.runOcr ? 'ENABLED' : 'SKIPPED' });
        window.SIH_Logger.log('GATE', `VISION`, { status: gateDecision?.runCv ? 'ENABLED' : 'SKIPPED' });
      }
      console.info(`[SIH][analysis ${generation}] Gate OCR=${Boolean(gateDecision?.runOcr)} CV=${Boolean(gateDecision?.runCv)}`);

      // ─────────────────────────────────────────────────────────────────
      // STAGE 1: IMMEDIATE LIGHTWEIGHT CONTEXT (PRIVACY-SAFE & FAST)
      // ─────────────────────────────────────────────────────────────────
      // Build SanitizedContext from DOM + Regex + ElementRegistry without waiting for visual models
      if (window.SIH_Logger) window.SIH_Logger.log('SANITIZE', `started`, { findings: fusedDetections.length });
      const lightweightContext = metrics
        ? window.SIH_Metrics.measure(metrics, 'sanitizeMs', () => window.SIH_Sanitizer.buildSanitizedContext(fusedDetections, null))
        : window.SIH_Sanitizer.buildSanitizedContext(fusedDetections, null);
      if (window.SIH_Logger) {
        window.SIH_Logger.log('CTX TRACE 12', 'Sanitization completed');
        window.SIH_Logger.log('SANITIZE', `completed`, { tokensCreated: fusedDetections.length, rawSensitiveDataPresent: false });
      }

      if (generation !== currentAnalysisGeneration) {
        console.warn(`[SIH][analysis ${generation}] superseded before lightweight publish; discarding`);
        return;
      }

      currentDetections = fusedDetections;
      currentSanitizedContext = lightweightContext;
      latestGateDecision = gateDecision;
      latestMetrics = metrics && window.SIH_Metrics.finish(metrics);
      lastProcessedUrl = getSanitizedPageUrl();
      lastProcessedHash = computePageHash();

      // Notify service worker that lightweight context is ready and chat can begin immediately!
      const t_contextReady = performance.now();
      console.info('[SIH][CONTENT LIFE] CONTEXT_READY emitted');
      if (window.SIH_Logger) {
        window.SIH_Logger.log('CTX TRACE 13', 'CONTEXT_READY emitted');
        window.SIH_Logger.log('CONTEXT', `CONTEXT_READY generation=${generation}`);
        window.SIH_Logger.log('CONTEXT', `CONTEXT_READY_SEND tabId=N/A generation=${generation} contextValid=${!!currentSanitizedContext} elements=${currentSanitizedContext?.elements?.length}`);
      }
      console.info(`[CONTEXT FLOW] content -> background CONTEXT_READY (lightweight gen=${generation}, total ${(t_contextReady - startMs).toFixed(1)}ms, elements=${currentSanitizedContext.elements?.length || 0})`);

      chrome.runtime.sendMessage({
        type: 'CONTEXT_READY',
        sanitizedContext: currentSanitizedContext,
        detectionCount: currentDetections.length,
        mapping: window.SIH_Sanitizer?.SIH_SanitizerState?.getDetectionSummary?.() || [],
        metrics: latestMetrics,
        gateDecision: latestGateDecision,
        url: getSanitizedPageUrl(),
        generation,
        isLightweight: true
      }).catch(() => {});

      // ─────────────────────────────────────────────────────────────────
      // STAGE 2: ASYNCHRONOUS VISUAL PERCEPTION & ENRICHMENT
      // ─────────────────────────────────────────────────────────────────
      // Visual enrichment runs ONLY when the gate determines it is needed.
      // It never blocks Stage 1 lightweight context — chat can begin immediately.
      //
      // Decision logic:
      //   runCv=true OR imageCount>0  →  run visual pipeline (MediaPipe face detection)
      //   runOcr=true                 →  if visual pipeline available: pass rects to worker
      //                                  if visual pipeline unavailable: run legacy OCR in-process
      //
      // The visual pipeline also runs OCR internally via the offscreen worker (future).
      // For now, OCR text-extraction runs in-process via runLegacyOcr when gate triggers.

      const visualPipelineAvailable = Boolean(window.SIH_VisualPipeline?.isAvailable());
      const needsVisual = gateDecision?.runCv || gateInput.imageCount > 0;
      const needsOcr    = gateDecision?.runOcr;

      if (needsVisual && visualPipelineAvailable) {
        // Run visual pipeline (screenshot + MediaPipe + future general visual model)
        // asynchronously in background — does NOT block chat
        console.info(`[PERCEPTION] gen=${generation} visual enrichment triggered (CV=${needsVisual} OCR=${needsOcr})`);
        if (window.SIH_Logger) window.SIH_Logger.log('VISION', `started`);
        runAsyncVisualEnrichment(generation, fusedDetections, gateDecision, metrics);
      } else if (needsOcr && window.SIH_OcrDetector?.isAvailable()) {
        // OCR fallback path: runs in-process when visual pipeline is unavailable
        // or when gate only requires OCR (no visual evidence / canvas).
        console.info(`[PERCEPTION] gen=${generation} OCR-only path triggered (visualPipeline=${visualPipelineAvailable})`);
        if (window.SIH_Logger) window.SIH_Logger.log('OCR', `started`);
        runLegacyOcr(metrics).then((legacyOcrResult) => {
          if (generation !== currentAnalysisGeneration) return;
          if (!legacyOcrResult.available || legacyOcrResult.detections.length === 0) return;
          console.info(`[PERCEPTION] gen=${generation} OCR returned ${legacyOcrResult.detections.length} detections`);
          if (window.SIH_Logger) window.SIH_Logger.log('OCR', `completed`, { findings: legacyOcrResult.detections.length });
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
            isEnriched: true,
            enrichedBy: 'ocr'
          }).catch(() => {});
        });
      }

    } catch (err) {
      console.error(`[SIH][analysis ${generation}] error:`, err?.message || err);
      notifyCompletion(null);
    } finally {
      activeAnalysisDetections = null;
      analysisState = 'IDLE';
      if (analysisPending) {
        analysisPending = false;
        console.info(`[SIH] Scheduling queued pending analysis after generation ${generation}`);
        // If we were superseded, the new generation is waiting to run.
        requestAnalysis({ immediate: true });
      }
    }
  }

  /**
   * Asynchronous Visual Enrichment Pipeline.
   *
   * Sends a VISUAL_ANALYZE request to the background service worker.
   * The background captures a screenshot, dispatches it to the offscreen
   * visual worker (MediaPipe face detection + future general visual model),
   * and returns a sanitized screenshot + visual detections.
   *
   * On success:
   *   - Merges visual detections into currentDetections via fusionFusion
   *   - Rebuilds SanitizedContext including the sanitized screenshot
   *   - Publishes enriched CONTEXT_READY to background
   *
   * On any failure:
   *   - Fails closed: never attaches an unsanitized screenshot
   *   - Does NOT affect the already-published lightweight context
   *   - Logs structured diagnostic output
   *
   * @param {number} generation         — stale-guard token
   * @param {Array}  baseDetections     — fused DOM+Regex detections to pass as safe rects
   * @param {object} gateDecision       — { runOcr, runCv, ... }
   * @param {object} metrics            — SIH_Metrics instance
   */
  async function runAsyncVisualEnrichment(generation, baseDetections, gateDecision, metrics) {
    const t_start = performance.now();
    try {
      // Build geometry-only safe rects (raw values intentionally stripped by visualPipeline.analyze)
      const existingRects = (baseDetections || [])
        .filter(d => d.rect && typeof d.rect.x === 'number')
        .map(d => ({
          type: d.type,
          source: d.source,
          x: d.rect.x,
          y: d.rect.y,
          width: d.rect.width,
          height: d.rect.height,
          confidence: d.confidence
          // NOTE: raw 'value' field intentionally EXCLUDED from rects
        }));

      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0
      };

      // Delegate: background captures screenshot + runs visual worker
      const visualResult = await window.SIH_VisualPipeline.analyze(
        null,          // dataUrl ignored — background captures fresh
        viewport,
        existingRects,
        generation
      );

      // Stale guard: discard if page changed during async pipeline
      if (generation !== currentAnalysisGeneration) {
        console.info(`[PERCEPTION] gen=${generation} visual enrichment discarded (superseded by gen=${currentAnalysisGeneration})`);
        return;
      }

      const visualDetections = Array.isArray(visualResult?.detections) ? visualResult.detections : [];
      const sanitizedDataUrl = visualResult?.sanitizedDataUrl || null;

      // Fail-closed: if visual pipeline encountered an error or backend is unavailable,
      // do NOT attach any screenshot or unverified detections.
      if (!visualResult?.ok || visualResult?.error || !sanitizedDataUrl || visualResult?.backend === 'unavailable') {
        console.info(`[PERCEPTION] gen=${generation} visual enrichment: pipeline error/unavailable, fail-closed (no screenshot attached). backend=${visualResult?.backend || 'unavailable'}`);
        return;
      }

      const t_visual = performance.now() - t_start;
      console.info(`[SIH][VISION TRACE 16]\ncontent received visual result\nsuccess=${visualResult?.backend !== 'unavailable'}\nfacesDetected=${visualDetections.filter(d => d.type === 'face').length}\nfacesMasked=${visualDetections.filter(d => d.type === 'face').length}\nscreenshotSanitized=${!!sanitizedDataUrl}`);
      console.info(
        `[PERCEPTION] gen=${generation} visual enrichment done: ` +
        `backend=${visualResult?.backend} faces=${visualDetections.filter(d => d.type === 'face').length} ` +
        `screenshot=${sanitizedDataUrl ? 'sanitized' : 'none'} totalMs=${t_visual.toFixed(1)}`
      );

      // Merge visual detections with existing
      const mergedDetections = window.SIH_DetectionFusion
        ? window.SIH_DetectionFusion.fuse([...currentDetections, ...visualDetections])
        : [...currentDetections, ...visualDetections];

      // Rebuild sanitized context — now includes the sanitized screenshot
      const enrichedContext = window.SIH_Sanitizer.buildSanitizedContext(
        mergedDetections,
        sanitizedDataUrl   // sanitized screenshot from visual worker (may be null)
      );

      // Final stale guard before publishing
      if (generation !== currentAnalysisGeneration) {
        console.info(`[PERCEPTION] gen=${generation} visual enrichment publish discarded (superseded)`);
        return;
      }

      // Update module-level state
      currentDetections = mergedDetections;
      currentSanitizedContext = enrichedContext;

      console.info(
        `[PRIVACY] gen=${generation} screenshot sanitized: ${sanitizedDataUrl ? 'TRUE' : 'NONE'}. ` +
        `Total detections after enrichment: ${currentDetections.length}`
      );

      // Publish enriched context (background will merge into tab state)
      chrome.runtime.sendMessage({
        type: 'CONTEXT_READY',
        sanitizedContext: enrichedContext,
        detectionCount: currentDetections.length,
        mapping: window.SIH_Sanitizer?.SIH_SanitizerState?.getDetectionSummary?.() || [],
        metrics: latestMetrics,
        gateDecision: latestGateDecision,
        url: getSanitizedPageUrl(),
        generation,
        isEnriched: true,
        enrichedBy: 'visual'
      }).catch(() => {});

    } catch (err) {
      // Visual enrichment failure is non-fatal — lightweight context remains valid
      console.warn(`[PERCEPTION] gen=${generation} visual enrichment error (non-fatal):`, err?.message || err);
      // Fail closed: do NOT attach any screenshot on error
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
      let reason = 'unknown';
      const significant = mutations.some(m => {
        const target = m.target;
        if (target && target.nodeType === 1) {
          // Ignore mutations inside extension-protected elements
          if (target.hasAttribute?.('data-sih-protected') || target.hasAttribute?.('data-sih-ignore') || target.id?.startsWith('sih-') || target.tagName?.toLowerCase() === 'canvas') {
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
                if (['script', 'style', 'link', 'noscript', 'canvas'].includes(tag)) continue;
                if (node.hasAttribute?.('data-sih-protected') || node.hasAttribute?.('data-sih-ignore') || node.id?.startsWith('sih-')) continue;
                return true;
              }
              if (node.nodeType === 3 && node.textContent.trim().length > 0) {
                return true;
              }
            }
            return false;
          };
          if (hasSignificantNode(m.addedNodes) || hasSignificantNode(m.removedNodes)) {
            reason = 'childList_significant';
            return true;
          }
          return false;
        }
        if (m.type === 'attributes') {
          if (['value', 'type', 'name', 'placeholder', 'aria-label'].includes(m.attributeName)) {
            reason = `attributes_${m.attributeName}`;
            return true;
          }
          return false;
        }
        return false;
      });

      console.info(`[SIH][MUTATION]\nmutationCount=${mutations.length}\ntriggerAccepted=${significant}\ndebounceState=${analysisState}\nreason=${reason}`);

      if (significant) {
        console.info(`[SIH][ANALYSIS TRIGGER]\nreason=mutation`);
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
