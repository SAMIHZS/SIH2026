importScripts(
  'logger.js',
  'providers/types.js',
  'providers/groqProvider.js',
  'providers/openRouterProvider.js',
  'providers/geminiProvider.js',
  'providers/localProvider.js',
  'modelManager.js',
  'agentCoordinator.js'
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
    const oldGen = 0;
    globalGenerationCounter++;
    const newGen = globalGenerationCounter;
    const txId = performance.now();
    tabPerceptionState.set(tabId, {
      tabId,
      generation: newGen,
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
    console.info(
      `[SIH][GENERATION TRACE]\n` +
      `tabId=${tabId}\n` +
      `oldGeneration=${oldGen}\n` +
      `newGeneration=${newGen}\n` +
      `reason=initial_state\n` +
      `navigationIdentity=${url || ''}\n` +
      `transactionId=${txId}`
    );
  }
  return tabPerceptionState.get(tabId);
}

/**
 * Invalidate tab perception state immediately.
 * This is a PRIVACY GUARANTEE: invalidation happens synchronously
 * before any new work begins.
 */
function invalidateTabContext(tabId, reason = 'unknown', newUrl = '', transactionId = null) {
  const existing = tabPerceptionState.get(tabId);
  const oldGen = existing ? existing.generation : 0;
  globalGenerationCounter++;
  const nextGen = globalGenerationCounter;
  const navIdentity = newUrl || (existing ? existing.navigationIdentity : '');
  const txId = transactionId !== null ? transactionId : performance.now();

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

  console.info(
    `[SIH][GENERATION TRACE]\n` +
    `tabId=${tabId}\n` +
    `oldGeneration=${oldGen}\n` +
    `newGeneration=${nextGen}\n` +
    `reason=${reason}\n` +
    `navigationIdentity=${navIdentity}\n` +
    `transactionId=${txId}`
  );

  self.SIH_Logger.log('PRIVACY', `CONTEXT INVALIDATED Tab: ${tabId} Generation: ${nextGen} Reason: ${reason}`);
  if (self.SIH_AgentCoordinator) {
    self.SIH_AgentCoordinator.handleNavigation(tabId, nextGen);
  }
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
async function dispatchToOffscreen(dataUrl, viewport, safeRects, tabId, generation) {
  await ensureOffscreenDocument();

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      target: 'OFFSCREEN',
      type: 'OFFSCREEN_ANALYZE',
      dataUrl,
      viewport,
      safeRects,
      tabId,
      generation
    }, (response) => {
      console.info(`[SIH][VISION TRACE DISPATCH] lastError=`, chrome.runtime.lastError);
      console.info('[SIH][VISUAL RESULT]', {
        success: Boolean(response?.result?.sanitizedDataUrl),
        backend: response?.result?.backend || 'unknown',
        detectionCount: Array.isArray(response?.result?.detections)
          ? response.result.detections.length
          : 0,
        discarded: Boolean(response?.result?.discarded),
        error: response?.result?.error || (chrome.runtime.lastError ? chrome.runtime.lastError.message : null)
      });

      if (chrome.runtime.lastError) {
        console.warn('[SIH][SW] Offscreen communication error:', chrome.runtime.lastError.message);
        resolve({
          ok: false,
          detections: [],
          sanitizedDataUrl: null,
          discarded: true,
          backend: 'unavailable',
          cvExecuted: false,
          ocrExecuted: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }
      if (!response || !response.ok || !response.result || response.result.backend === 'unavailable' || !response.result.sanitizedDataUrl) {
        console.warn('[SIH][SW] Offscreen returned empty or error response:', response?.result?.error || 'unspecified');
        resolve({
          ok: false,
          detections: [],
          sanitizedDataUrl: null,
          discarded: true,
          backend: 'unavailable',
          cvExecuted: false,
          ocrExecuted: false,
          error: response?.result?.error || 'Offscreen analysis failed'
        });
        return;
      }
      resolve(response.result);
    });
  });
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Context Refresh Coordinator                                                   */
/* ─────────────────────────────────────────────────────────────────────────── */

const refreshLocks = new Map(); // tabId -> { refreshing: boolean, pendingRefresh: boolean, pendingReason: string, pendingUrl: string }

function requestContextRefresh(tabId, reason, url = '') {
  if (!tabId) return;

  let currentGen = tabPerceptionState.has(tabId) ? tabPerceptionState.get(tabId).generation : null;
  console.info(`[SIH][REFRESH CALL]\ntabId=${tabId}\nreason=${reason}\ncurrentGeneration=${currentGen}\ncaller/source=requestContextRefresh\nrefreshLockState=${refreshLocks.has(tabId) ? refreshLocks.get(tabId).refreshing : false}\ntimestamp=${Date.now()}`);

  const lock = refreshLocks.get(tabId) || { refreshing: false, pendingRefresh: false, pendingReason: '', pendingUrl: '' };
  if (!refreshLocks.has(tabId)) refreshLocks.set(tabId, lock);

  if (lock.refreshing) {
    // Coalesce sidebar_init: if a refresh is already happening, we don't need another one
    // just because the sidebar opened.
    if (reason === 'sidebar_init') {
      self.SIH_Logger.log('CONTEXT', `refresh coalesced (ignored) tab=${tabId} reason=${reason}`);
      return;
    }

    lock.pendingRefresh = true;
    lock.pendingReason = reason;
    lock.pendingUrl = url || lock.pendingUrl;
    self.SIH_Logger.log('CONTEXT', `refresh coalesced (queued) tab=${tabId} reason=${reason}`);
    return;
  }

  lock.refreshing = true;
  self.SIH_Logger.log('CTX TRACE 04', 'refresh lock acquired');
  self.SIH_Logger.log('CONTEXT', `REFRESH_LOCK_ACQUIRED tab=${tabId} reason=${reason}`);

  const timeoutId = setTimeout(() => {
    if (lock.refreshing) {
      console.warn(`[SIH][CONTEXT] REFRESH_TIMEOUT for tab=${tabId}`);
      lock.refreshing = false;
      if (lock.pendingRefresh) {
        const nextReason = lock.pendingReason;
        const nextUrl = lock.pendingUrl;
        lock.pendingRefresh = false;
        lock.pendingReason = '';
        lock.pendingUrl = '';
        requestContextRefresh(tabId, nextReason, nextUrl);
      }
    }
  }, 5000);

  executeContextRefresh(tabId, reason, url).finally(() => {
    clearTimeout(timeoutId);
    if (!lock.refreshing) return; // already timed out
    lock.refreshing = false;
    self.SIH_Logger.log('CONTEXT', `REFRESH_LOCK_RELEASED tab=${tabId}`);

    if (lock.pendingRefresh) {
      const nextReason = lock.pendingReason;
      const nextUrl = lock.pendingUrl;
      lock.pendingRefresh = false;
      lock.pendingReason = '';
      lock.pendingUrl = '';
      requestContextRefresh(tabId, nextReason, nextUrl);
    }
  });
}

async function executeContextRefresh(tabId, reason, url = '') {
  const t0 = performance.now();
  const newGen = invalidateTabContext(tabId, reason, url, t0);
  const currentState = tabPerceptionState.get(tabId);

  self.SIH_Logger.log('CTX TRACE 03', 'refresh requested');
  self.SIH_Logger.log('CONTEXT', `refresh requested reason=${reason} tab=${tabId} generation=${newGen}`);
  self.SIH_Logger.log('CONTEXT', `refresh started tab=${tabId} generation=${newGen}`);
  self.SIH_Logger.log('CONTEXT', `build started generation=${newGen}`);

  broadcastToExtensionPages({
    type: 'CONTEXT_INVALIDATED',
    tabId,
    generation: newGen,
    navigationIdentity: currentState.navigationIdentity,
    reason,
    t0
  });

  await fetchAndBroadcastTabContext(tabId, newGen, t0);
  self.SIH_Logger.log('CONTEXT', `refresh completed tab=${tabId} generation=${newGen}`);
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Tab Lifecycle — Immediate Invalidation                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * chrome.tabs.onActivated: fires when user switches to a different tab.
 * Invalidation happens FIRST before any perception begins for the new tab.
 */
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const prevTabId = activeTabId;
  activeTabId = tabId;
  if (prevTabId && prevTabId !== tabId) {
    self.SIH_Logger.log('LIFECYCLE', `tab deactivated tab=${prevTabId}`);
  }
  self.SIH_Logger.log('LIFECYCLE', `tab activated tab=${tabId}`);

  let currentTabUrl = '';
  try {
    const tabInfo = await chrome.tabs.get(tabId);
    currentTabUrl = tabInfo.url || '';
  } catch (e) {}

  const existingState = tabPerceptionState.get(tabId);
  if (
    existingState &&
    existingState.isValid &&
    existingState.sanitizedContext &&
    (!currentTabUrl || currentTabUrl === existingState.navigationIdentity)
  ) {
    // Returning to an existing tab that has not navigated does NOT create a new generation
    self.SIH_Logger.log('CONTEXT', `tab activated cache hit tab=${tabId} generation=${existingState.generation}`);
    broadcastToExtensionPages({
      type: 'CONTEXT_UPDATE',
      tabId,
      generation: existingState.generation,
      navigationIdentity: existingState.navigationIdentity,
      sanitizedContext: existingState.sanitizedContext,
      screenshot: existingState.screenshot,
      detectionCount: existingState.detectionCount,
      mapping: existingState.mapping,
      metrics: existingState.metrics,
      gateDecision: existingState.gateDecision,
      visual: existingState.screenshot || null
    });
    broadcastToExtensionPages({
      type: 'VISUAL_CONTEXT_UPDATE',
      tabId,
      generation: existingState.generation,
      visual: existingState.screenshot || {
        available: false,
        sanitizedDataUrl: null,
        status: 'waiting',
        message: 'Waiting for local visual processing...'
      }
    });
    return;
  }

  requestContextRefresh(tabId, 'tab_activated');
});

/**
 * chrome.tabs.onUpdated: fires for navigation events.
 * Same-tab navigation immediately invalidates previous generation.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId !== activeTabId) return;

  const currentTabState = tabPerceptionState.get(tabId);
  const targetUrl = changeInfo.url || tab.url || '';

  // 1. Navigation detected: status is loading or URL changed
  if (changeInfo.url || changeInfo.status === 'loading') {
    // Only invalidate if new navigation (URL differs or state was valid from previous page)
    if (!currentTabState || (targetUrl && currentTabState.navigationIdentity !== targetUrl) || currentTabState.isValid) {
      const t0 = performance.now();
      const newGen = invalidateTabContext(tabId, 'navigation', targetUrl, t0);
      broadcastToExtensionPages({
        type: 'CONTEXT_INVALIDATED',
        tabId,
        generation: newGen,
        navigationIdentity: targetUrl,
        reason: 'navigation',
        t0
      });
      broadcastToExtensionPages({
        type: 'VISUAL_CONTEXT_UPDATE',
        tabId,
        generation: newGen,
        visual: {
          available: false,
          sanitizedDataUrl: null,
          status: 'waiting',
          message: 'Waiting for local visual processing...'
        }
      });
    }
    return;
  }

  // 2. Navigation completed: status is complete
  if (changeInfo.status === 'complete') {
    const currentState = tabPerceptionState.get(tabId);
    if (!currentState || (tab.url && currentState.navigationIdentity !== tab.url)) {
      requestContextRefresh(tabId, 'navigation_complete', tab.url);
      return;
    }

    if (!currentState.isValid) {
      const t0 = performance.now();
      await fetchAndBroadcastTabContext(tabId, currentState.generation, t0);
    }
  }
});

/**
 * Content-script dependency chain declared in manifest.json (exact order).
 */
const CONTENT_SCRIPT_FILES = [
  'logger.js',
  'detectors/domDetector.js',
  'detectors/regexDetector.js',
  'detectors/ocrDetector.js',
  'vision/visualPipeline.js',
  'metrics.js',
  'perceptionSchema.js',
  'detectionGate.js',
  'detectionFusion.js',
  'elementRegistry.js',
  'grounding.js',
  'sanitize.js',
  'validate.js',
  'execute.js',
  'content.js'
];

function isRestrictedUrl(url) {
  if (!url) return false;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('view-source:') ||
    url.startsWith('devtools://')
  );
}

/**
 * Ensure content script is available and responsive in the target tab.
 * If genuinely absent (e.g. after extension reload), programmatically injects
 * the exact manifest dependency chain once, bounded.
 */
async function ensureContentScriptAvailable(tabId) {
  let tabUrl = '';
  try {
    const tabInfo = await chrome.tabs.get(tabId);
    tabUrl = tabInfo.url || tabInfo.pendingUrl || '';
  } catch (e) {
    console.warn(`[SIH][CTX BOOTSTRAP] Failed to get tab info: ${e.message}`);
    return { ok: false, reason: 'TAB_NOT_FOUND', error: e.message };
  }

  if (isRestrictedUrl(tabUrl)) {
    console.info(`[SIH][CTX BOOTSTRAP]\ntabId=${tabId}\nurl=${tabUrl}\nping=FAILED\nreason=RESTRICTED_URL`);
    return { ok: false, reason: 'RESTRICTED_URL', url: tabUrl };
  }

  // 1. Initial fast PING attempts (delays: 0ms, 150ms)
  const initialDelays = [0, 150];
  let pingOk = false;
  for (let i = 0; i < initialDelays.length; i++) {
    if (initialDelays[i] > 0) {
      await new Promise(r => setTimeout(r, initialDelays[i]));
    }
    try {
      console.info(`[SIH][CTX HANDSHAKE] PING_SEND attempt ${i+1}`);
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (pong && pong.ok) {
        console.info(`[SIH][CTX HANDSHAKE] PONG_RECEIVED`);
        pingOk = true;
        break;
      }
    } catch (e) {
      console.info(`[SIH][CTX HANDSHAKE] PING_FAILED: ${e.message}`);
    }
  }

  if (pingOk) {
    console.info(`[SIH][CTX BOOTSTRAP]\ntabId=${tabId}\nurl=${tabUrl}\nping=SUCCESS`);
    return { ok: true, injected: false };
  }

  console.info(`[SIH][CTX BOOTSTRAP]\ntabId=${tabId}\nurl=${tabUrl}\nping=FAILED`);

  // 2. Programmatic injection fallback (exactly once, bounded)
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
    console.error(`[SIH][CTX BOOTSTRAP]\ncontentScript=INJECTION_UNAVAILABLE\nrecovery=FAILED`);
    return { ok: false, reason: 'SCRIPTING_API_UNAVAILABLE' };
  }

  console.info(`[SIH][CTX BOOTSTRAP]\ncontentScript=INJECTING`);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });
    console.info(`[SIH][CTX BOOTSTRAP]\ncontentScript=INJECTED`);
  } catch (injectErr) {
    console.error(`[SIH][CTX BOOTSTRAP]\ncontentScript=INJECTION_FAILED\nerror=${injectErr.message}\nrecovery=FAILED`);
    return { ok: false, reason: 'INJECTION_FAILED', error: injectErr.message };
  }

  // 3. Post-injection PING attempts (delays: 50ms, 150ms, 300ms)
  const postDelays = [50, 150, 300];
  let postPongOk = false;
  for (let i = 0; i < postDelays.length; i++) {
    await new Promise(r => setTimeout(r, postDelays[i]));
    try {
      console.info(`[SIH][CTX HANDSHAKE] POST_INJECTION_PING attempt ${i+1}`);
      const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (pong && pong.ok) {
        console.info(`[SIH][CTX HANDSHAKE] POST_INJECTION_PONG_RECEIVED`);
        postPongOk = true;
        break;
      }
    } catch (e) {
      console.info(`[SIH][CTX HANDSHAKE] POST_INJECTION_PING_FAILED: ${e.message}`);
    }
  }

  if (postPongOk) {
    console.info(`[SIH][CTX BOOTSTRAP]\npong=SUCCESS\nrecovery=SUCCESS`);
    return { ok: true, injected: true };
  }

  console.error(`[SIH][CTX BOOTSTRAP]\npong=FAILED\nrecovery=FAILED`);
  return { ok: false, reason: 'POST_INJECTION_PONG_TIMEOUT' };
}

/**
 * Fetch lightweight context from the tab's content script and wait for CONTEXT_READY.
 */
function fetchAndBroadcastTabContext(tabId, generation, t0) {
  return new Promise(async (resolve) => {
    let settled = false;

    // Check if URL is supported
    let tabUrl = '';
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      tabUrl = tabInfo.url || tabInfo.pendingUrl || '';
    } catch (e) {
      console.warn(`[SIH][CTX TX] Failed to get tab info: ${e.message}`);
    }

    if (isRestrictedUrl(tabUrl)) {
      console.info(`[SIH][CTX TX] URL restricted, skipping content script injection: ${tabUrl}`);
      broadcastToExtensionPages({
        type: 'CONTEXT_UPDATE',
        tabId,
        generation,
        navigationIdentity: tabUrl,
        sanitizedContext: null,
        detectionCount: 0,
        mapping: [],
        status: 'UNSUPPORTED_URL',
        statusMessage: 'Browser page — assistant unavailable on this page'
      });
      resolve(false);
      return;
    }

    // Controlled Content-Script Availability / Recovery
    const bootstrap = await ensureContentScriptAvailable(tabId);
    if (!bootstrap.ok) {
      const failureReason = bootstrap.reason || 'CONTENT_UNAVAILABLE';
      console.error(`[SIH][CTX] CONTENT_UNAVAILABLE\ntabId=${tabId}\ngeneration=${generation}\nreason=${failureReason}`);
      broadcastToExtensionPages({
        type: 'CONTEXT_UPDATE',
        tabId,
        generation,
        navigationIdentity: tabPerceptionState.get(tabId)?.navigationIdentity || tabUrl,
        sanitizedContext: null,
        detectionCount: 0,
        mapping: [],
        status: 'CONTENT_UNAVAILABLE',
        statusMessage: bootstrap.reason === 'RESTRICTED_URL'
          ? 'Browser page — assistant unavailable on this page'
          : 'Page context unavailable. Refresh the page to reconnect'
      });
      resolve(false);
      return;
    }

    console.info(`[SIH][CTX TX] GET_CONTEXT_SEND\ntabId=${tabId}\ngeneration=${generation}\ntransactionId=${t0}`);
    self.SIH_Logger.log('CTX TRACE 05', 'GET_CONTEXT sent to content');

    // Register a global resolver so CONTEXT_READY can unlock this transaction
    if (!self._contextResolvers) self._contextResolvers = new Map();
    const resolverKey = `${tabId}_${generation}`;

    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        self._contextResolvers.delete(resolverKey);
        self.SIH_Logger.log('CONTEXT', `GET_CONTEXT timed out tab=${tabId} generation=${generation}`);
        console.error(`[SIH][CTX TX] TIMEOUT tabId=${tabId} generation=${generation}`);
        broadcastToExtensionPages({
          type: 'CONTEXT_UPDATE',
          tabId,
          generation,
          navigationIdentity: tabPerceptionState.get(tabId)?.navigationIdentity,
          sanitizedContext: null,
          detectionCount: 0,
          mapping: [],
          status: 'TIMEOUT',
          statusMessage: 'Page context response timed out'
        });
        resolve(false);
      }
    }, 5000);

    self._contextResolvers.set(resolverKey, (success) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      self._contextResolvers.delete(resolverKey);
      resolve(success);
    });

    chrome.tabs.sendMessage(tabId, { type: 'GET_CONTEXT', generation: generation }, (response) => {
      // We only care about immediate failures here. Success is handled by CONTEXT_READY.
      if (chrome.runtime.lastError) {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          self._contextResolvers.delete(resolverKey);
          self.SIH_Logger.log('CONTEXT', `GET_CONTEXT failed tab=${tabId} generation=${generation} error="${chrome.runtime.lastError.message}"`);
          console.error(`[SIH][CTX TX] GET_CONTEXT_FAILED\ntabId=${tabId}\ngeneration=${generation}\nerror="${chrome.runtime.lastError.message}"`);

          broadcastToExtensionPages({
            type: 'CONTEXT_UPDATE',
            tabId,
            generation,
            navigationIdentity: tabPerceptionState.get(tabId)?.navigationIdentity,
            sanitizedContext: null,
            detectionCount: 0,
            mapping: [],
            status: 'CONTENT_UNAVAILABLE',
            statusMessage: 'Page context unavailable. Refresh the page to reconnect'
          });
          resolve(false);
        }
      }
    });
  });
}

// Track initial active tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs && tabs[0]) {
    activeTabId = tabs[0].id;
    getOrCreateTabState(activeTabId, tabs[0].url);
    console.info(`[SIH][SW] Active tab initialized: ${activeTabId}`);
  }
});

/**
 * Tab Close Cleanup (Phase 3B/3C):
 * Synchronously purge tab perception state, sanitized screenshot,
 * and refresh locks when a tab closes. No persistent storage is used.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabPerceptionState.has(tabId)) {
    const state = tabPerceptionState.get(tabId);
    if (state) {
      state.screenshot = null;
      state.sanitizedContext = null;
      state.detections = [];
      state.mapping = [];
    }
    tabPerceptionState.delete(tabId);
  }
  refreshLocks.delete(tabId);
  if (self._contextResolvers) {
    for (const key of self._contextResolvers.keys()) {
      if (key.startsWith(`${tabId}_`)) {
        self._contextResolvers.delete(key);
      }
    }
  }
  if (activeTabId === tabId) {
    activeTabId = null;
  }
  if (self.SIH_AgentCoordinator) {
    self.SIH_AgentCoordinator.handleTabClosed(tabId);
  }
  console.info(`[SIH][TAB CLEANUP] tabId=${tabId} state and screenshot removed from memory`);
});

/* ─────────────────────────────────────────────────────────────────────────── */
/* Message Routing & Stale-Result Guards                                       */
/* ─────────────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  // Handle diagnostics from Offscreen Document (scoped to originating tab/generation/request)
  if (message.type === 'OFFSCREEN_DIAGNOSTIC') {
    const targetTabId = message.tabId || activeTabId;
    if (targetTabId) {
      chrome.tabs.sendMessage(targetTabId, {
        type: 'VISUAL_DIAGNOSTIC',
        stage: message.stage,
        data: message.data,
        tabId: targetTabId,
        generation: message.generation,
        requestId: message.requestId
      }).catch(() => {});
    }
    return false;
  }

  switch (message.type) {
    case 'REQUEST_CONTEXT_REFRESH': {
      const tabId = message.tabId || activeTabId;
      if (!tabId) {
        sendResponse({ ok: false, error: 'No active tab' });
        return false;
      }
      requestContextRefresh(tabId, 'manual_refresh');
      sendResponse({ ok: true });
      return false;
    }

    case 'CONTEXT_READY': {
      const callerTabId = sender.tab?.id;
      if (!callerTabId) {
        sendResponse({ ok: false, error: 'No tab ID' });
        return false;
      }

      const currentTabState = tabPerceptionState.get(callerTabId);
      const incomingGeneration = message.generation;
      const incomingIdentity = message.url || '';

      self.SIH_Logger.log('CTX TRACE 14', 'background received CONTEXT_READY');
      self.SIH_Logger.log('CONTEXT', `CONTEXT_READY_RECEIVED tabId=${callerTabId} generation=${incomingGeneration} currentGeneration=${currentTabState?.generation} contextValid=${!!message.sanitizedContext}`);

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
      if (message.sanitizedContext?.screenshot) {
        if (!currentTabState.screenshot) {
          currentTabState.screenshot = {
            sanitizedDataUrl: message.sanitizedContext.screenshot,
            generation: incomingGeneration,
            tabId: callerTabId,
            backend: 'mediapipe',
            cvExecuted: true,
            ocrExecuted: false,
            detections: [],
            detectionCount: 0,
            sanitized: true
          };
        }
      }
      currentTabState.updatedAt = performance.now();
      currentTabState.isValid = true;

      self.SIH_Logger.log('CTX TRACE 15', 'context stored');
      self.SIH_Logger.log('CONTEXT', `CONTEXT_STORED tabId=${callerTabId} generation=${incomingGeneration}`);

      // Broadcast update to sidebar
      self.SIH_Logger.log('CTX TRACE 16', 'sidebar context broadcast');
      self.SIH_Logger.log('CONTEXT', `SIDEBAR_CONTEXT_BROADCAST tabId=${callerTabId} generation=${incomingGeneration}`);
      broadcastToExtensionPages({
        type: 'CONTEXT_UPDATE',
        tabId: callerTabId,
        generation: incomingGeneration,
        navigationIdentity: currentTabState.navigationIdentity,
        sanitizedContext: message.sanitizedContext,
        detectionCount: message.detectionCount,
        mapping: message.mapping,
        metrics: message.metrics || null,
        gateDecision: message.gateDecision || null,
        visual: currentTabState.screenshot || null
      });

      // Signal completion to fetchAndBroadcastTabContext
      if (self._contextResolvers) {
        const resolverKey = `${callerTabId}_${incomingGeneration}`;
        const resolver = self._contextResolvers.get(resolverKey);
        if (resolver) {
          resolver(true);
        }
      }

      sendResponse({ ok: true });
      return false;
    }

    case 'GET_LATEST_CONTEXT': {
      self.SIH_Logger.log('CTX TRACE 02', 'background received GET_LATEST_CONTEXT');
      const tabId = activeTabId;
      const state = tabId && tabPerceptionState.get(tabId);

      // If we already have a context for this tab, just return it so the UI doesn't break,
      // even if it's currently marked invalid (refreshing).
      if (state && state.sanitizedContext) {
        self.SIH_Logger.log('CONTEXT', `cache hit tab=${tabId} generation=${state.generation}`);
        sendResponse({
          sanitizedContext: state.sanitizedContext,
          detectionCount: state.detectionCount,
          mapping: state.mapping,
          metrics: state.metrics,
          gateDecision: state.gateDecision,
          tabId,
          generation: state.generation,
          navigationIdentity: state.navigationIdentity,
          isValid: state.isValid,
          visual: state.screenshot || null
        });
        return false;
      }

      self.SIH_Logger.log('CONTEXT', `cache miss tab=${tabId}`);
      // Only request a refresh if no refresh is currently running for this tab
      // (This prevents sidebar_init from queuing up repeated refreshes)
      if (tabId) {
        const lock = refreshLocks.get(tabId);
        if (!lock || (!lock.refreshing && !lock.pendingRefresh)) {
          requestContextRefresh(tabId, 'sidebar_init');
        } else {
          console.info(`[SIH][CONTEXT] GET_LATEST_CONTEXT: refresh already in progress for tab ${tabId}`);
        }
      }

      if (state && state.navigationIdentity && isRestrictedUrl(state.navigationIdentity)) {
        sendResponse({
          sanitizedContext: null,
          tabId,
          generation: state ? state.generation : 0,
          navigationIdentity: state ? state.navigationIdentity : '',
          status: 'UNSUPPORTED_URL',
          statusMessage: 'Browser page — assistant unavailable on this page'
        });
        return false;
      }

      sendResponse({
        sanitizedContext: null,
        tabId,
        generation: state ? state.generation : 0,
        navigationIdentity: state ? state.navigationIdentity : ''
      });
      return false;
    }

    case 'VISUAL_ANALYZE': {
      console.info(`[SIH][VISION BG 01] VISUAL_ANALYZE received tabId=${sender.tab?.id || 'none'} generation=${message.generation || 0} hasScreenshot=${message.hasScreenshot} requestedCV=${message.requestedCV} requestedOCR=${message.requestedOCR}`);
      console.info(`[SIH][VISION TRACE 3]\nbackground received VISUAL_ANALYZE\ngeneration=${message.generation || 0}\ntabId=${sender.tab?.id || 'none'}\nkeys=${Object.keys(message).join(',')}`);
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
          console.info(`[SIH][VISION BG 02] screenshot capture starting`);
          console.info(`[SIH][VISION TRACE 4]\nbackground starting visual pipeline`);
          console.info(`[SIH][VISION TRACE 5]\ncalling captureVisibleTab`);
          const t_captureStart = performance.now();
          let screenshot;
          try {
            screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
            console.info(`[SIH][VISION BG 03] screenshot captured width=unknown height=unknown byte/data URL presence=${!!screenshot}`);
            console.info(`[SIH][VISION TRACE 6]\ncaptureVisibleTab succeeded\nlength=${screenshot.length}`);
          } catch (captureErr) {
            console.warn(`[SIH][VISION BG ERROR]\nerror.name=${captureErr.name}\nerror.message=${captureErr.message}\nstack=${captureErr.stack}`);
            console.warn(`[SIH][VISION ERROR]\nstage=captureVisibleTab\nmessage=${captureErr.message}`);
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
            sendResponse({
              ok: false,
              error: 'captureVisibleTab returned empty',
              sanitizedDataUrl: null,
              detections: [],
              discarded: true,
              backend: 'unavailable',
              cvExecuted: false,
              ocrExecuted: false,
              generation: requestedGeneration
            });
            return;
          }

          // Check staleness before expensive offscreen/worker inference
          if (
            callerTabId !== activeTabId ||
            currentTabState.generation !== requestedGeneration
          ) {
            console.info(`[PRIVACY STATE] STALE RESULT DISCARDED Tab: ${callerTabId} Generation: ${requestedGeneration} Current generation: ${currentTabState.generation} Reason: navigation/tab changed`);
            screenshot = null; // discard
            sendResponse({
              ok: false,
              error: 'Stale analysis discarded',
              sanitizedDataUrl: null,
              detections: [],
              discarded: true,
              backend: 'unavailable',
              cvExecuted: false,
              ocrExecuted: false,
              generation: requestedGeneration
            });
            return;
          }

          // 2. Dispatch to Offscreen Document -> Dedicated Visual Worker
          console.info(`[SIH][VISION BG 04] dispatching to offscreen`);
          console.info(`[SIH][VISION TRACE 7]\nsending OFFSCREEN_ANALYZE`);
          const t_workerStart = performance.now();
          const workerResult = await dispatchToOffscreen(screenshot, message.viewport || {}, message.safeRects || [], callerTabId, requestedGeneration);
          screenshot = null; // Discard raw screenshot from memory immediately
          console.info(`[SIH][VISION BG 05] offscreen response received`);
          const t_workerMs = performance.now() - t_workerStart;
          const totalMs = performance.now() - t_analyzeStart;

          // Check staleness after worker execution finishes
          if (
            callerTabId !== activeTabId ||
            currentTabState.generation !== requestedGeneration
          ) {
            console.info(`[PRIVACY STATE] STALE RESULT DISCARDED Tab: ${callerTabId} Generation: ${requestedGeneration} Current generation: ${currentTabState.generation} Reason: navigation/tab changed`);
            sendResponse({
              ok: false,
              error: 'Stale analysis discarded',
              sanitizedDataUrl: null,
              detections: [],
              discarded: true,
              backend: 'unavailable',
              cvExecuted: false,
              ocrExecuted: false,
              generation: requestedGeneration
            });
            return;
          }

          // Check if visual processing failed closed or unavailable
          if (!workerResult || !workerResult.ok || !workerResult.sanitizedDataUrl || workerResult.backend === 'unavailable') {
            currentTabState.screenshot = null;
            const visualFailure = {
              available: false,
              sanitizedDataUrl: null,
              generation: requestedGeneration,
              tabId: callerTabId,
              backend: 'unavailable',
              cvExecuted: false,
              ocrExecuted: false,
              detections: [],
              detectionCount: 0,
              processingMs: totalMs,
              sanitized: false,
              error: workerResult?.error || 'CV_UNAVAILABLE'
            };
            broadcastToExtensionPages({
              type: 'VISUAL_CONTEXT_UPDATE',
              tabId: callerTabId,
              generation: requestedGeneration,
              visual: visualFailure
            });
            sendResponse({
              ok: false,
              sanitizedDataUrl: null,
              detections: [],
              discarded: true,
              backend: 'unavailable',
              cvExecuted: false,
              ocrExecuted: false,
              captureMs: t_captureMs,
              workerMs: t_workerMs,
              totalMs,
              generation: requestedGeneration,
              error: workerResult?.error || 'CV_UNAVAILABLE'
            });
            return;
          }

          // Cache sanitized screenshot in state for this generation ONLY
          const visualEvidence = {
            available: true,
            sanitizedDataUrl: workerResult.sanitizedDataUrl,
            generation: requestedGeneration,
            tabId: callerTabId,
            backend: workerResult.backend || 'mediapipe',
            cvExecuted: true,
            ocrExecuted: Boolean(workerResult.ocrExecuted),
            ocrAvailable: Boolean(workerResult.ocrAvailable),
            ocrText: workerResult.ocrText || '',
            detections: (workerResult.detections || []).map(d => ({
              type: d.type || 'sensitive',
              source: d.source || 'mediapipe',
              x: d.x,
              y: d.y,
              width: d.width,
              height: d.height,
              confidence: d.confidence
            })),
            detectionCount: workerResult.detections?.length || 0,
            processingMs: totalMs,
            sanitized: true
          };

          currentTabState.screenshot = visualEvidence;

          broadcastToExtensionPages({
            type: 'VISUAL_CONTEXT_UPDATE',
            tabId: callerTabId,
            generation: requestedGeneration,
            visual: visualEvidence
          });

          console.group('[SIH][SW] VISUAL_ANALYZE completed via Offscreen Document');
          console.info('Tab:', callerTabId, '| Generation:', requestedGeneration);
          console.info('[CAPTURE] Time:', `${t_captureMs.toFixed(1)}ms`);
          console.info('[OFFSCREEN WORKER] Backend:', workerResult.backend);
          console.info('[OFFSCREEN WORKER] Detections:', workerResult.detections?.length || 0);
          console.info('[SCREENSHOT] Sanitized:', workerResult.sanitizedDataUrl ? 'TRUE' : 'NULL (fail-closed)');
          console.info('[TIMING] Total:', `${totalMs.toFixed(1)}ms`);
          console.groupEnd();

          console.info(`[SIH][VISION BG 06] returning visual response`);
          console.info(`[SIH][VISION TRACE 15]\nbackground returning visual result\nsuccess=${workerResult.backend !== 'unavailable'}\nfacesDetected=${workerResult.detections?.length || 0}\nfacesMasked=${workerResult.detections?.length || 0}\nscreenshotSanitized=${!!workerResult.sanitizedDataUrl}`);

          sendResponse({
            ok: true,
            sanitizedDataUrl: workerResult.sanitizedDataUrl,
            detections: workerResult.detections || [],
            discarded: false,
            backend: workerResult.backend || 'mediapipe',
            cvExecuted: true,
            ocrExecuted: Boolean(workerResult.ocrExecuted),
            ocrAvailable: Boolean(workerResult.ocrAvailable),
            ocrText: workerResult.ocrText || '',
            ocrDebug: workerResult.ocrDebug || null,
            captureMs: t_captureMs,
            workerMs: t_workerMs,
            totalMs,
            generation: requestedGeneration,
            error: null
          });
        } catch (outerErr) {
          console.error(`[SIH][VISION BG ERROR]\nerror.name=${outerErr.name}\nerror.message=${outerErr.message}\nstack=${outerErr.stack}`);
          console.error('[SIH][SW] VISUAL_ANALYZE error:', outerErr.message);
          currentTabState.screenshot = null;
          broadcastToExtensionPages({
            type: 'VISUAL_CONTEXT_UPDATE',
            tabId: callerTabId,
            generation: requestedGeneration,
            visual: {
              available: false,
              sanitizedDataUrl: null,
              generation: requestedGeneration,
              tabId: callerTabId,
              backend: 'unavailable',
              cvExecuted: false,
              ocrExecuted: false,
              detections: [],
              detectionCount: 0,
              sanitized: false,
              error: outerErr.message || 'VISUAL_PIPELINE_ERROR'
            }
          });
          sendResponse({
            ok: false,
            sanitizedDataUrl: null,
            detections: [],
            discarded: true,
            backend: 'unavailable',
            cvExecuted: false,
            ocrExecuted: false,
            error: outerErr.message || 'VISUAL_PIPELINE_ERROR',
            generation: requestedGeneration
          });
        }
      })();
      return true; // async
    }

    case 'SEND_TO_BACKEND': {
      handleBackendRequest(message, sender).then(sendResponse);
      return true;
    }

    case 'START_AGENT_TRANSACTION': {
      const tabId = message.tabId || activeTabId;
      const currentTabState = tabPerceptionState.get(tabId);
      const generation = message.generation || currentTabState?.generation || 1;
      const goal = message.goal || '';

      if (!self.SIH_AgentCoordinator) {
        sendResponse({ success: false, error: 'AGENT_COORDINATOR_UNAVAILABLE' });
        return false;
      }

      const txResult = self.SIH_AgentCoordinator.createTransaction({
        tabId,
        generation,
        requestId: message.requestId,
        goal,
        maxSteps: message.maxSteps
      });

      if (!txResult.success) {
        sendResponse(txResult);
        return false;
      }

      const tx = txResult.transaction;
      sendResponse({ success: true, transactionId: tx.transactionId, maxSteps: tx.maxSteps });

      // Run multi-step agent transaction loop
      self.SIH_AgentCoordinator.runTransactionLoop(tx.transactionId, {
        observePage: async (tId, gen) => {
          const freshState = tabPerceptionState.get(tId);
          const invResp = await new Promise((res) => {
            chrome.tabs.sendMessage(tId, { type: 'QUERY_GROUNDING', query: 'inventory', generation: gen, tabId: tId }, (r) => res(r || {}));
          });
          return {
            tabId: tId,
            generation: freshState?.generation || gen,
            url: freshState?.navigationIdentity || '',
            elementCount: invResp.inventory?.length || 0,
            inventory: invResp.inventory || [],
            sanitizedContext: freshState?.sanitizedContext
          };
        },
        planStep: async (context, userGoal, history) => {
          if (typeof message.mockPlanStep === 'function') {
            return message.mockPlanStep(context, userGoal, history);
          }
          const prompt = `Goal: ${userGoal}`;
          return handleBackendRequest({
            tabId,
            generation: context.generation,
            userMessage: prompt,
            sanitizedContext: context.sanitizedContext
          }, sender);
        },
        groundAction: (action, gen, tId) => {
          // Pass-through to content script validation/grounding during EXECUTE_ACTION
          return { success: true, elementId: action.elementId || action.target };
        },
        validateAction: (action, gen, tId) => {
          return { allowed: true };
        },
        executeAction: async (action, gen) => {
          return new Promise((res) => {
            chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action, tabId }, (r) => res(r || { success: false, error: 'No response' }));
          });
        },
        settleWait: (ms) => new Promise(r => setTimeout(r, ms)),
        onStatusUpdate: (status) => {
          broadcastToExtensionPages({ type: 'AGENT_STATUS_UPDATE', status, tabId });
        }
      }).catch(err => {
        console.error('[SIH][AGENT] Loop failed with unhandled exception:', err);
      });

      return false;
    }

    case 'GET_AGENT_STATUS': {
      const tabId = message.tabId || activeTabId;
      if (!self.SIH_AgentCoordinator) {
        sendResponse({ status: 'Agent: Idle' });
        return false;
      }
      const tx = self.SIH_AgentCoordinator.getActiveTransaction(tabId);
      sendResponse({
        status: self.SIH_AgentCoordinator.getSidebarStatus(tx),
        transaction: tx ? {
          transactionId: tx.transactionId,
          stepIndex: tx.stepIndex,
          maxSteps: tx.maxSteps,
          status: tx.status
        } : null
      });
      return false;
    }

    case 'CANCEL_AGENT_TRANSACTION': {
      if (!self.SIH_AgentCoordinator) {
        sendResponse({ success: false, error: 'AGENT_COORDINATOR_UNAVAILABLE' });
        return false;
      }
      const success = self.SIH_AgentCoordinator.cancelTransaction(message.transactionId, message.reason);
      sendResponse({ success });
      return false;
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

  const modelConfig = await modelManager.getConfig();
  const selectedProviderId = modelConfig.selectedProvider;
  const selectedProvider = modelConfig.providers[selectedProviderId];

  // Gate 5: Check Local provider availability explicitly
  if (selectedProviderId === 'local') {
    return {
      type: 'text',
      message: 'Local browser inference is not available in this build.',
      error: 'PROVIDER_UNAVAILABLE',
      errorCode: 'PROVIDER_UNAVAILABLE',
      isMock: false
    };
  }

  const isVisionCapable = modelManager.isVisionCapable(selectedProviderId, modelConfig.selectedModel);
  const visual = activeState.screenshot;

  // Gate 6: Hard Privacy Gate for Visual / Image Context
  if (!isVisionCapable) {
    // Model is text-only: NEVER send screenshot or visual artifact
    delete sanitizedContext.screenshot;
    delete sanitizedContext.screenshotDataUrl;
    delete sanitizedContext.visualProvenance;
  } else {
    // Model is vision-capable:
    // If a screenshot is present or requested, verify ALL conditions:
    if (sanitizedContext.screenshot || visual) {
      // Condition D & G: Visual artifact exists and has verified sanitized status
      if (!visual || visual.sanitized !== true) {
        throw new Error('UNTRUSTED_VISUAL_ARTIFACT');
      }
      // Condition E: Belongs to same tab
      if (visual.tabId !== activeTabId || visual.tabId !== requestTabId) {
        return failClosed('Screenshot tab mismatch — cross-tab leakage blocked');
      }
      // Condition F: Generation match
      if (visual.generation !== activeState.generation || (requestGeneration !== undefined && visual.generation !== requestGeneration)) {
        return failClosed('Screenshot generation mismatch — stale generation blocked');
      }
      // Condition H: Valid PNG data URL
      if (!visual.sanitizedDataUrl || typeof visual.sanitizedDataUrl !== 'string' || !visual.sanitizedDataUrl.startsWith('data:image/png;base64,')) {
        return {
          type: 'text',
          message: 'Sanitized visual context is unavailable for this page.',
          error: 'SANITIZED_VISUAL_CONTEXT_UNAVAILABLE',
          isMock: false
        };
      }
      // Condition I: Not marked unavailable
      if (visual.available === false || visual.backend === 'unavailable') {
        return {
          type: 'text',
          message: 'Sanitized visual context is unavailable for this page.',
          error: 'SANITIZED_VISUAL_CONTEXT_UNAVAILABLE',
          isMock: false
        };
      }

      // Attach strictly sanitized image with provenance
      sanitizedContext.screenshot = visual.sanitizedDataUrl;
      sanitizedContext.visualProvenance = {
        sanitized: true,
        tabId: activeTabId,
        generation: activeState.generation,
        backend: visual.backend,
        ocr: {
          available: Boolean(visual.ocrAvailable),
          executed: Boolean(visual.ocrExecuted),
          text: visual.ocrText || ''
        }
      };
      if (visual.ocrText) {
        sanitizedContext.ocrText = visual.ocrText;
      }
      console.info(`[PRIVACY GATE] Attached verified sanitized screenshot (tab=${activeTabId} gen=${activeState.generation})`);
    }
  }

  console.info(
    `[PRIVACY GATE] OK — tab=${requestTabId} gen=${activeState.generation} ` +
    `screenshot=${sanitizedContext.screenshot ? 'SANITIZED' : 'NONE'} ` +
    `elements=${sanitizedContext.elements?.length || 0}`
  );

  if (selectedProviderId && selectedProvider?.configured) {
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
        provider: selectedProviderId,
        tabId: activeTabId,
        generation: activeState.generation
      };
    } catch (err) {
      const classified = (self.SIH_AgentCoordinator && typeof self.SIH_AgentCoordinator.classifyProviderError === 'function')
        ? self.SIH_AgentCoordinator.classifyProviderError(err)
        : { code: 'PROVIDER_FAILED', message: 'Provider request failed' };
      console.warn('[SIH][backend] Provider failed safely:', classified.code);
      return {
        type: 'text',
        message: `The selected AI provider is unavailable: ${classified.message}`,
        isMock: false,
        provider: selectedProviderId,
        errorCode: classified.code
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
  // Legacy capture endpoint — fail closed to prevent raw screenshot exposure
  return {
    error: 'Direct screenshot capture deprecated. Use authoritative visual pipeline.',
    screenshot: null
  };
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
