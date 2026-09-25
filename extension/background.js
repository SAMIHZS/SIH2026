importScripts(
  'providers/types.js',
  'providers/groqProvider.js',
  'providers/openRouterProvider.js',
  'providers/geminiProvider.js',
  'providers/localProvider.js',
  'modelManager.js'
);

/**
 * Service Worker (Background) — SIH26171 MV3 Architecture
 *
 * Responsibilities:
 * 1. Tab lifecycle & Immediate Context Invalidation (Privacy State Machine)
 * 2. Per-tab perception state isolation: (tabId, navigationIdentity, generation)
 * 3. Offscreen Document lifecycle management (reason: ['WORKERS'])
 * 4. Stale-result protection & Fail-closed Provider Payload Gate
 * 5. Viewport screenshot capture via chrome.tabs.captureVisibleTab
 * 6. Forwarding visual analysis requests to the Offscreen Document
 * 7. Extension message routing (content ↔ sidebar ↔ popup ↔ offscreen)
 *
 * MV3 Architectural Invariant:
 *   Service workers NEVER call new Worker().
 *   Visual worker is owned exclusively by the minimal offscreen document.
 */

/* ─────────────────────────────────────────────────────────────────────────── */
/* Privacy State Machine & Per-Tab State                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Per-tab perception state store. Keyed by tabId (number).
 *
 * Each tab state tracks:
 *   tabId                - number
 *   generation           - number (strictly incremented on any navigation/reset)
 *   navigationIdentity   - string (URL or unique document identity)
 *   sanitizedContext     - object | null
 *   screenshot           - string | null (strictly generation-bound sanitized data URL)
 *   detections           - Array
 *   mapping              - Array
 *   detectionCount       - number
 *   metrics              - object | null
 *   gateDecision         - object | null
 *   updatedAt            - number (timestamp)
 *   isValid              - boolean
 */
const tabPerceptionState = new Map();

/** Currently active tab ID as tracked by the service worker. */
let activeTabId = null;

/** Global generation counter ensuring strictly monotonically increasing IDs across tabs. */
let globalGenerationCounter = 0;

/** Provider ModelManager instance. */
const modelManager = new self.SIH_ModelManager.ModelManager();

/**
 * Get or initialize perception state for a tab.
 */
function getOrCreateTabState(tabId, url = '') {
  if (!tabPerceptionState.has(tabId)) {
    globalGenerationCounter++;
    tabPerceptionState.set(tabId, {
      tabId,
      generation: globalGenerationCounter,
      navigationIdentity: url || '',
      sanitizedContext: null,
      screenshot: null,
      detections: [],
      mapping: [],
      detectionCount: 0,
      metrics: null,
      gateDecision: null,
      updatedAt: performance.now(),
      isValid: false
    });
  }
  return tabPerceptionState.get(tabId);
}

/**
 * Invalidate tab perception state immediately.
 * This is a PRIVACY GUARANTEE: invalidation happens synchronously
 * before any new work begins.
 */
function invalidateTabContext(tabId, reason = 'unknown', newUrl = '') {
  const existing = tabPerceptionState.get(tabId);
  globalGenerationCounter++;
  const nextGen = globalGenerationCounter;

  if (existing) {
    existing.isValid = false;
    existing.sanitizedContext = null;
    existing.screenshot = null;
    existing.detections = [];
    existing.mapping = [];
    existing.detectionCount = 0;
    existing.generation = nextGen;
    if (newUrl) {
      existing.navigationIdentity = newUrl;
    }
    existing.updatedAt = performance.now();
  } else {
    tabPerceptionState.set(tabId, {
      tabId,
      generation: nextGen,
      navigationIdentity: newUrl || '',
      sanitizedContext: null,
      screenshot: null,
      detections: [],
      mapping: [],
      detectionCount: 0,
      metrics: null,
      gateDecision: null,
      updatedAt: performance.now(),
      isValid: false
    });
  }

  console.info(`[PRIVACY STATE] CONTEXT INVALIDATED Tab: ${tabId} Generation: ${nextGen} Reason: ${reason}`);
  return nextGen;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Offscreen Document Lifecycle (MV3 Compliant)                                */
/* ────────────────────────────────────────────────────────────────────────##─ */

let creatingOffscreenPromise = null;

/**
 * Ensure the minimal offscreen document exists to host the dedicated worker.
 * Guarantees a single offscreen document using a concurrency lock.
 */
async function ensureOffscreenDocument() {
  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  // Check if offscreen document already exists
  if (chrome.offscreen?.hasDocument) {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) return;
  } else if (chrome.runtime.getContexts) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });
      if (contexts && contexts.length > 0) return;
    } catch (_) {}
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run local visual sanitization and MediaPipe inference in a dedicated worker without blocking the page.'
  });

  try {
    await creatingOffscreenPromise;
    console.info('[SIH][SW] Offscreen document created with reason [WORKERS]');
  } catch (err) {
    // If created concurrently by another event, ignore the already-exists error
    if (!err?.message?.includes('Only a single offscreen document may be created')) {
      console.error('[SIH][SW] Failed to create offscreen document:', err);
      throw err;
    }
  } finally {
    creatingOffscreenPromise = null;
  }
}

/**
 * Route visual analysis to the Offscreen Document.
 * Fail-closed: returns sanitizedDataUrl: null if offscreen document fails.
 */
async function dispatchToOffscreen(dataUrl, viewport, safeRects) {
  await ensureOffscreenDocument();

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      target: 'OFFSCREEN',
      type: 'OFFSCREEN_ANALYZE',
      dataUrl,
      viewport,
      safeRects
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[SIH][SW] Offscreen communication error:', chrome.runtime.lastError.message);
        resolve({
          detections: [],
          sanitizedDataUrl: null,
          backend: 'unavailable',
          error: chrome.runtime.lastError.message
        });
        return;
      }
      if (!response || !response.ok || !response.result) {
        console.warn('[SIH][SW] Offscreen returned empty or error response');
        resolve({
          detections: [],
          sanitizedDataUrl: null,
          backend: 'unavailable',
          error: response?.result?.error || 'Offscreen analysis failed'
        });
        return;
      }
      resolve(response.result);
    });
  });
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Tab Lifecycle — Immediate Invalidation                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * chrome.tabs.onActivated: fires when user switches to a different tab.
 * Invalidation happens FIRST before any perception begins for the new tab.
 */
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const t0 = performance.now();
  const prevTabId = activeTabId;
  activeTabId = tabId;

  // 1. Invalidate previous tab context if one was active
  if (prevTabId && prevTabId !== tabId) {
    invalidateTabContext(prevTabId, 'tab_deactivated');
  }

  // 2. Increment & initialize new tab generation
  const newGen = invalidateTabContext(tabId, 'tab_activated');
  const currentState = tabPerceptionState.get(tabId);

  console.info(`[SIH][tabs.onActivated] tabId=${tabId} prevTabId=${prevTabId} gen=${newGen}`);

  // 3. Immediately broadcast CONTEXT_INVALIDATED to sidebar/popup
  broadcastToExtensionPages({
    type: 'CONTEXT_INVALIDATED',
    tabId,
    prevTabId,
    generation: newGen,
    navigationIdentity: currentState.navigationIdentity,
    t0
  });

  // 4. Query fresh tab context (lightweight fetch)
  fetchAndBroadcastTabContext(tabId, newGen, t0);
});

/**
 * chrome.tabs.onUpdated: fires for navigation events.
 * Same-tab navigation immediately invalidates previous generation.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== activeTabId) return;

  // If URL changes or page begins loading / completes
  if (changeInfo.url || changeInfo.status === 'loading') {
    const t0 = performance.now();
    const newGen = invalidateTabContext(tabId, 'navigation_start', changeInfo.url || tab.url);
    const currentState = tabPerceptionState.get(tabId);

    broadcastToExtensionPages({
      type: 'CONTEXT_INVALIDATED',
      tabId,
      url: changeInfo.url || tab.url,
      generation: newGen,
      navigationIdentity: currentState.navigationIdentity,
      reason: 'navigation',
      t0
    });
    return;
  }

  if (changeInfo.status === 'complete') {
    const t0 = performance.now();
    const currentState = tabPerceptionState.get(tabId);
    const gen = currentState ? currentState.generation : invalidateTabContext(tabId, 'navigation_complete', tab.url);

    // Fetch fresh context with small delay for content script initialization
    setTimeout(() => {
      if (tabId === activeTabId && currentState && currentState.generation === gen) {
        fetchAndBroadcastTabContext(tabId, gen, t0);
      }
    }, 350);
  }
});

/**
 * Fetch lightweight context from the tab's content script and broadcast if valid.
 */
async function fetchAndBroadcastTabContext(tabId, generation, t0) {
  try {
    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'GET_CONTEXT', generation: generation }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });

    // Stale guard: verify tab is still active and generation matches
    const currentState = tabPerceptionState.get(tabId);
    if (
      tabId !== activeTabId ||
      !currentState ||
      currentState.generation !== generation
    ) {
      console.info(`[PRIVACY STATE] STALE RESULT DISCARDED Tab: ${tabId} Generation: ${generation} Current generation: ${currentState?.generation} Reason: navigation/tab changed`);
      return;
    }

    if (res && res.sanitizedContext) {
      currentState.sanitizedContext = res.sanitizedContext;
      currentState.mapping = res.mapping || [];
      currentState.detectionCount = res.detections ? res.detections.length : 0;
      currentState.metrics = res.metrics || null;
      currentState.gateDecision = res.gateDecision || null;
      currentState.updatedAt = performance.now();
      currentState.isValid = true;

      broadcastToExtensionPages({
        type: 'CONTEXT_UPDATE',
        tabId,
        generation,
        navigationIdentity: currentState.navigationIdentity,
        sanitizedContext: res.sanitizedContext,
        detectionCount: currentState.detectionCount,
        mapping: currentState.mapping,
        metrics: currentState.metrics,
        gateDecision: currentState.gateDecision,
        timings: { activationToContextMs: performance.now() - t0 }
      });
    } else {
      // Empty/loading state
      broadcastToExtensionPages({
        type: 'CONTEXT_UPDATE',
        tabId,
        generation,
        navigationIdentity: currentState.navigationIdentity,
        sanitizedContext: null,
        detectionCount: 0,
        mapping: [],
        timings: { activationToContextMs: performance.now() - t0 }
      });
    }
  } catch (err) {
    console.warn('[SIH] Failed to fetch tab context:', err.message);
  }
}

// Track initial active tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs && tabs[0]) {
    activeTabId = tabs[0].id;
    getOrCreateTabState(activeTabId, tabs[0].url);
    console.info(`[SIH][SW] Active tab initialized: ${activeTabId}`);
  }
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Message Routing & Stale-Result Guards                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  // Handle diagnostics from Offscreen Document
  if (message.type === 'OFFSCREEN_DIAGNOSTIC') {
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, {
        type: 'VISUAL_DIAGNOSTIC',
        stage: message.stage,
        data: message.data
      }).catch(() => {});
    }
    return false;
  }

  switch (message.type) {

    case 'CONTEXT_READY': {
      const callerTabId = sender.tab?.id;
      if (!callerTabId) {
        sendResponse({ ok: false, error: 'No tab ID' });
        return false;
      }

      const currentTabState = tabPerceptionState.get(callerTabId);
      const incomingGeneration = message.generation;
      const incomingIdentity = message.url || '';

      // STALE ASYNC RESULT GUARD
      if (
        callerTabId !== activeTabId ||
        !currentTabState ||
        incomingGeneration !== currentTabState.generation ||
        (incomingIdentity && currentTabState.navigationIdentity && !incomingIdentity.startsWith(currentTabState.navigationIdentity) && !currentTabState.navigationIdentity.startsWith(incomingIdentity))
      ) {
        console.info(`[PRIVACY STATE] STALE RESULT DISCARDED Tab: ${callerTabId} Generation: ${incomingGeneration} Current generation: ${currentTabState?.generation} Reason: navigation/tab changed`);
        sendResponse({ ok: false, discarded: true });
        return false;
      }

      currentTabState.sanitizedContext = message.sanitizedContext;
      currentTabState.mapping = message.mapping || [];
      currentTabState.detectionCount = message.detectionCount || 0;
      currentTabState.metrics = message.metrics || null;
      currentTabState.gateDecision = message.gateDecision || null;
      currentTabState.screenshot = message.sanitizedContext?.screenshot || null;
      currentTabState.updatedAt = performance.now();
      currentTabState.isValid = true;

      // Broadcast update to sidebar
      broadcastToExtensionPages({
        type: 'CONTEXT_UPDATE',
        tabId: callerTabId,
        generation: incomingGeneration,
        navigationIdentity: currentTabState.navigationIdentity,
        sanitizedContext: message.sanitizedContext,
        detectionCount: message.detectionCount,
        mapping: message.mapping,
        metrics: message.metrics || null,
        gateDecision: message.gateDecision || null
      });

      sendResponse({ ok: true });
      return false;
    }

    case 'GET_LATEST_CONTEXT': {
      const tabId = activeTabId;
      const state = tabId && tabPerceptionState.get(tabId);
      if (state && state.isValid && state.sanitizedContext) {
        sendResponse({
          sanitizedContext: state.sanitizedContext,
          detectionCount: state.detectionCount,
          mapping: state.mapping,
          metrics: state.metrics,
          gateDecision: state.gateDecision,
          tabId,
          generation: state.generation,
          navigationIdentity: state.navigationIdentity
        });
        return false;
      }

      // Fetch on demand from active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (!activeTab) { sendResponse({ sanitizedContext: null }); return; }
        const tid = activeTab.id;
        const curState = getOrCreateTabState(tid, activeTab.url);
        chrome.tabs.sendMessage(tid, { type: 'GET_CONTEXT', generation: curState.generation }, (res) => {
          if (chrome.runtime.lastError || !res) {
            sendResponse({ sanitizedContext: null, tabId: tid, generation: curState.generation });
            return;
          }
          if (res.sanitizedContext) {
            curState.sanitizedContext = res.sanitizedContext;
            curState.mapping = res.mapping || [];
            curState.detectionCount = res.detections ? res.detections.length : 0;
            curState.metrics = res.metrics;
            curState.gateDecision = res.gateDecision;
            curState.updatedAt = performance.now();
            curState.isValid = true;
          }
          sendResponse({
            sanitizedContext: res.sanitizedContext || null,
            detectionCount: res.detections ? res.detections.length : 0,
            mapping: res.mapping || [],
            metrics: res.metrics,
            gateDecision: res.gateDecision,
            tabId: tid,
            generation: curState.generation,
            navigationIdentity: curState.navigationIdentity
          });
        });
      });
      return true; // async
    }

    case 'VISUAL_ANALYZE': {
      const callerTabId = sender.tab?.id;
      if (!callerTabId) {
        sendResponse({ error: 'VISUAL_ANALYZE must originate from a tab', sanitizedDataUrl: null });
        return false;
      }

      const requestedGeneration = message.generation;
      const t_analyzeStart = performance.now();
      const currentTabState = tabPerceptionState.get(callerTabId);

      // Verify not already stale
      if (
        callerTabId !== activeTabId ||
        !currentTabState ||
        requestedGeneration !== currentTabState.generation
      ) {
        console.info(`[PRIVACY STATE] STALE RESULT DISCARDED Tab: ${callerTabId} Generation: ${requestedGeneration} Current generation: ${currentTabState?.generation} Reason: navigation/tab changed`);
        sendResponse({
          error: 'Analysis cancelled: tab or page changed',
          sanitizedDataUrl: null,
          detections: [],
          discarded: true
        });
        return false;
      }

      (async () => {
        try {
          // 1. Capture viewport screenshot
          const t_captureStart = performance.now();
          let screenshot;
          try {
            screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
          } catch (captureErr) {
            console.warn(`[SIH][SW] captureVisibleTab failed: ${captureErr.message}`);
            sendResponse({
              error: `Screenshot capture failed: ${captureErr.message}`,
              sanitizedDataUrl: null,
              detections: [],
              backend: 'unavailable',
              timings: { captureFailedMs: performance.now() - t_captureStart }
            });
            return;
          }
          const t_captureMs = performance.now() - t_captureStart;

          if (!screenshot) {
            sendResponse({ error: 'captureVisibleTab returned empty', sanitizedDataUrl: null, detections: [] });
            return;
          }

          // Check staleness before expensive offscreen/worker inference
          if (
            callerTabId !== activeTabId ||
            currentTabState.generation !== requestedGeneration
          ) {
            console.info(`[PRIVACY STATE] STALE RESULT DISCARDED Tab: ${callerTabId} Generation: ${requestedGeneration} Current generation: ${currentTabState.generation} Reason: navigation/tab changed`);
            sendResponse({ error: 'Stale analysis discarded', sanitizedDataUrl: null, detections: [], discarded: true });
            return;
          }

          // 2. Dispatch to Offscreen Document -> Dedicated Visual Worker
          const t_workerStart = performance.now();
          const workerResult = await dispatchToOffscreen(screenshot, message.viewport || {}, message.safeRects || []);
          const t_workerMs = performance.now() - t_workerStart;
          const totalMs = performance.now() - t_analyzeStart;

          // Check staleness after worker execution finishes
          if (
            callerTabId !== activeTabId ||
            currentTabState.generation !== requestedGeneration
          ) {
            console.info(`[PRIVACY STATE] STALE RESULT DISCARDED Tab: ${callerTabId} Generation: ${requestedGeneration} Current generation: ${currentTabState.generation} Reason: navigation/tab changed`);
            sendResponse({ error: 'Stale analysis discarded', sanitizedDataUrl: null, detections: [], discarded: true });
            return;
          }

          // Cache sanitized screenshot in state for this generation
          currentTabState.screenshot = workerResult.sanitizedDataUrl;

          console.group('[SIH][SW] VISUAL_ANALYZE completed via Offscreen Document');
          console.info('Tab:', callerTabId, '| Generation:', requestedGeneration);
          console.info('[CAPTURE] Time:', `${t_captureMs.toFixed(1)}ms`);
          console.info('[OFFSCREEN WORKER] Backend:', workerResult.backend);
          console.info('[OFFSCREEN WORKER] Detections:', workerResult.detections?.length || 0);
          console.info('[SCREENSHOT] Sanitized:', workerResult.sanitizedDataUrl ? 'TRUE' : 'NULL (fail-closed)');
          console.info('[TIMING] Total:', `${totalMs.toFixed(1)}ms`);
          console.groupEnd();

          sendResponse({
            ...workerResult,
            captureMs: t_captureMs,
            workerMs: t_workerMs,
            totalMs,
            generation: requestedGeneration
          });
        } catch (outerErr) {
          console.error('[SIH][SW] VISUAL_ANALYZE error:', outerErr.message);
          sendResponse({ error: outerErr.message, sanitizedDataUrl: null, detections: [] });
        }
      })();
      return true; // async
    }

    case 'SEND_TO_BACKEND': {
      handleBackendRequest(message, sender).then(sendResponse);
      return true;
    }

    case 'MODEL_GET_CONFIG':
      modelManager.getPublicConfig().then(sendResponse);
      return true;

    case 'MODEL_SAVE_CONFIG':
      if (!isPrivilegedExtensionRequest(sender)) {
        sendResponse({ error: 'Provider configuration is restricted to extension pages' });
        return false;
      }
      modelManager.saveConfig(message.config || {})
        .then(() => modelManager.getPublicConfig())
        .then(config => {
          broadcastToExtensionPages({ type: 'MODEL_CONFIG_UPDATE', config });
          sendResponse(config);
        })
        .catch(error => sendResponse({ error: error.message }));
      return true;

    case 'MODEL_LIST_MODELS':
      if (!isPrivilegedExtensionRequest(sender)) {
        sendResponse({ error: 'Provider model discovery is restricted to extension pages' });
        return false;
      }
      modelManager.listModels(message.providerId).then(
        models => sendResponse({ models }),
        error => sendResponse({ error: error.message })
      );
      return true;

    case 'MODEL_TEST_CONNECTION':
      if (!isPrivilegedExtensionRequest(sender)) {
        sendResponse({ available: false, error: 'Provider testing is restricted to extension pages' });
        return false;
      }
      modelManager.testConnection(message.providerId)
        .then(sendResponse)
        .catch(error => sendResponse({ available: false, error: error.message }));
      return true;

    case 'CAPTURE_SCREENSHOT':
      handleScreenshotCapture(message, sender).then(sendResponse);
      return true;

    case 'GET_PRIVACY_STATE':
      chrome.storage.local.get(['privacyEnabled'], (result) => {
        sendResponse({ enabled: result.privacyEnabled !== false });
      });
      return true;

    case 'SET_PRIVACY_STATE':
      chrome.storage.local.set({ privacyEnabled: message.enabled }, () => {
        sendResponse({ ok: true });
      });
      return true;

    default:
      return false;
  }
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Provider Payload Gate & Backend Handler                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Send SanitizedContext to the configured provider with strict generation binding.
 *
 * FAIL-CLOSED PROVIDER PAYLOAD GATE:
 * Asserts:
 * 1. Context exists
 * 2. Context is sanitized
 * 3. Context belongs to currently active tab
 * 4. Context generation matches current page generation
 * 5. Navigation identity matches
 * 6. Screenshot, if present, belongs to the same generation and is sanitized
 * 7. No stale context is being reused
 */
async function handleBackendRequest(message, sender) {
  const requestTabId = message.tabId || sender.tab?.id || activeTabId;
  const requestGeneration = message.generation;
  const requestNavIdentity = message.navigationIdentity;
  const userMessage = message.userMessage || '';

  const activeState = tabPerceptionState.get(activeTabId);

  // ── PROVIDER PAYLOAD GATE INVARIANTS ──
  const failClosed = (reason) => {
    console.warn(`[PRIVACY GATE] REMOTE TRANSMISSION BLOCKED: ${reason}`);
    return {
      type: 'text',
      message: 'Page context changed. Please retry.',
      error: 'CONTEXT_INVALIDATED',
      isMock: false
    };
  };

  if (!activeTabId || !activeState) {
    return failClosed('No active tab state found');
  }

  // Gate 1: Belongs to active tab
  if (requestTabId !== activeTabId) {
    return failClosed(`Request tab (${requestTabId}) does not match active tab (${activeTabId})`);
  }

  // Gate 2: Generation match (if provided with request)
  if (requestGeneration !== undefined && requestGeneration !== activeState.generation) {
    return failClosed(`Request generation (${requestGeneration}) does not match active generation (${activeState.generation})`);
  }

  // Gate 3: Navigation identity match (if provided)
  if (requestNavIdentity && activeState.navigationIdentity && requestNavIdentity !== activeState.navigationIdentity) {
    return failClosed('Navigation identity mismatch');
  }

  // Gate 4: Context exists and is marked valid
  const sanitizedContext = message.sanitizedContext || activeState.sanitizedContext;
  if (!sanitizedContext || !activeState.isValid) {
    return {
      type: 'text',
      message: 'No page context available yet. Please wait for the page to be analyzed.',
      isMock: false
    };
  }

  // Gate 5: Screenshot ownership & sanitization assertion
  if (sanitizedContext.screenshot) {
    if (typeof sanitizedContext.screenshot !== 'string' || !sanitizedContext.screenshot.startsWith('data:image/')) {
      return failClosed('Screenshot is not a valid local data URL');
    }
    // Verify screenshot belongs to current generation
    if (!activeState.screenshot || activeState.screenshot !== sanitizedContext.screenshot) {
      return failClosed('Screenshot data does not match active page generation');
    }
  }

  const modelConfig = await modelManager.getConfig();
  const selectedProvider = modelConfig.providers[modelConfig.selectedProvider];

  if (modelConfig.selectedProvider && selectedProvider?.configured) {
    try {
      // Re-verify gate immediately before remote dispatch
      if (activeTabId !== requestTabId || activeState.generation !== (requestGeneration || activeState.generation)) {
        return failClosed('Context invalidated immediately prior to provider dispatch');
      }

      const response = await modelManager.chat(sanitizedContext, userMessage);

      // Re-verify gate after remote dispatch returns
      if (activeTabId !== requestTabId || activeState.generation !== (requestGeneration || activeState.generation)) {
        console.info(`[PRIVACY STATE] Provider response arrived after tab switch/navigation; discarding`);
        return failClosed('Page context changed during AI request');
      }

      return {
        ...response,
        isMock: false,
        provider: modelConfig.selectedProvider,
        tabId: activeTabId,
        generation: activeState.generation
      };
    } catch (err) {
      console.warn('[SIH][backend] Provider failed:', err.message);
      return {
        type: 'text',
        message: `The selected AI provider is unavailable: ${err.message}`,
        isMock: false,
        provider: modelConfig.selectedProvider,
        errorCode: 'PROVIDER_UNAVAILABLE'
      };
    }
  }

  // Deterministic mock fallback
  return getDeterministicMockResponse(sanitizedContext, userMessage, activeTabId, activeState.generation);
}

/**
 * Deterministic mock when no real provider is configured.
 */
function getDeterministicMockResponse(sanitizedContext, userMessage, tabId, generation) {
  const lowerMsg = (userMessage || '').toLowerCase();

  if (lowerMsg.includes('click') || lowerMsg.includes('press') || lowerMsg.includes('submit')) {
    const button = sanitizedContext.elements?.find(e =>
      e.tag === 'button' || (e.tag === 'input' && (e.role === 'button' || e.role === 'submit'))
    );
    if (button && button.id) {
      return {
        type: 'action',
        action: {
          action: 'click',
          target: button.id,
          riskLevel: 'low',
          generation
        },
        tabId,
        generation,
        isMock: true,
        mockReason: '[MOCK FALLBACK] No provider configured — using deterministic fallback'
      };
    }
  }

  if (lowerMsg.includes('search') || lowerMsg.includes('type') || lowerMsg.includes('enter')) {
    const input = sanitizedContext.elements?.find(e =>
      e.tag === 'input' && !['submit', 'button', 'hidden'].includes(e.role)
    );
    if (input && input.id) {
      return {
        type: 'action',
        action: {
          action: 'type',
          target: input.id,
          value: 'test search',
          riskLevel: 'low',
          generation
        },
        tabId,
        generation,
        isMock: true,
        mockReason: '[MOCK FALLBACK] No provider configured — using deterministic fallback'
      };
    }
  }

  if (lowerMsg.includes('scroll')) {
    return {
      type: 'action',
      action: {
        action: 'scroll',
        target: '',
        value: '300',
        riskLevel: 'low',
        generation
      },
      tabId,
      generation,
      isMock: true,
      mockReason: '[MOCK FALLBACK] No provider configured — using deterministic fallback'
    };
  }

  return {
    type: 'text',
    message: `[MOCK FALLBACK — No AI provider configured]\n\nPage: "${sanitizedContext.page?.title || 'Unknown'}"\n` +
      `Interactive elements: ${sanitizedContext.elements?.length || 0}\n` +
      `Screenshot attached: ${Boolean(sanitizedContext.screenshot)}\n\n` +
      `Configure a provider in Settings to enable real AI responses.`,
    tabId,
    generation,
    isMock: true,
    mockReason: 'No provider configured'
  };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Screenshot Capture Helper                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

async function handleScreenshotCapture(message, sender) {
  try {
    const tabId = message.tabId || sender.tab?.id || activeTabId;
    if (!tabId) return { error: 'No tab ID available' };

    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    const rectsResponse = await chrome.tabs.sendMessage(tabId, { type: 'GET_RECTS' });
    const rects = rectsResponse?.rects || [];

    if (rects.length === 0) {
      return { screenshot: dataUrl };
    }

    const redactionStarted = performance.now();
    const redactionResponse = await chrome.tabs.sendMessage(tabId, {
      type: 'REDACT_SCREENSHOT',
      dataUrl,
      rects
    });
    if (!redactionResponse?.redactedScreenshot) {
      return { error: redactionResponse?.error || 'Local screenshot redaction failed' };
    }
    return {
      screenshot: redactionResponse.redactedScreenshot,
      redacted: true,
      timings: { redactionMs: performance.now() - redactionStarted }
    };
  } catch (err) {
    console.error('[SIH] Screenshot capture failed:', err);
    return { error: err.message };
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Utility                                                                     */
/* ─────────────────────────────────────────────────────────────────────────── */

function isPrivilegedExtensionRequest(sender) {
  const extensionId = chrome.runtime.id;
  const extensionOrigin = `chrome-extension://${extensionId}/`;
  const extensionOriginWithoutSlash = extensionOrigin.slice(0, -1);
  const senderUrl = typeof sender?.url === 'string' ? sender.url : '';
  const senderOrigin = typeof sender?.origin === 'string' ? sender.origin : '';
  const tabUrl = typeof sender?.tab?.url === 'string' ? sender.tab.url : '';
  const isExtensionUrl = senderUrl.startsWith(extensionOrigin);
  const isExtensionOrigin = senderOrigin === extensionOriginWithoutSlash;
  const isExtensionTabUrl = tabUrl.startsWith(extensionOrigin);
  const isSameExtensionWithoutPageMetadata = sender?.id === extensionId && !sender?.tab && !senderUrl && !senderOrigin;
  return sender?.id === extensionId && (isExtensionUrl || isExtensionOrigin || isExtensionTabUrl || isSameExtensionWithoutPageMetadata);
}

function broadcastToExtensionPages(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Side panel setup
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
