/**
 * Minimal Assistant Sidebar Script - SIH26171 Phase A-D
 */
document.addEventListener('DOMContentLoaded', () => {
  const logger = window.SIH_Logger || { log: console.log, error: console.error };

  // DOM Elements
  const emptyState = document.getElementById('emptyState');
  const conversationStream = document.getElementById('conversationStream');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const closeBtn = document.getElementById('closeBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const modelSelect = document.getElementById('sidebarModelSelect');

  // Navigation & Views (Phase 13)
  const tabChat = document.getElementById('tabChat');
  const tabContext = document.getElementById('tabContext');
  const tabPrivacy = document.getElementById('tabPrivacy');
  const chatView = document.getElementById('chatView');
  const contextView = document.getElementById('contextView');
  const privacyView = document.getElementById('privacyView');
  const chatPrivacyBadge = document.getElementById('chatPrivacyBadge');
  const headerSelectedModel = document.getElementById('headerSelectedModel');

  // Settings Modal (Phase 13)
  const settingsModal = document.getElementById('settingsModal');
  const closeSettingsModalBtn = document.getElementById('closeSettingsModalBtn');
  const settingsModalBackdrop = document.getElementById('settingsModalBackdrop');
  const openFullOptionsBtn = document.getElementById('openFullOptionsBtn');

  // Confirmation UI
  const confirmationDialog = document.getElementById('confirmationDialog');
  const confirmActionDesc = document.getElementById('confirmationActionDesc');
  const confirmDomain = document.getElementById('confirmationDomain');
  const confirmAllowBtn = document.getElementById('confirmAllowBtn');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');

  // Security Context Elements
  const securityBanner = document.getElementById('securityBanner');
  const securityNoticeText = document.getElementById('securityNoticeText');
  const detailsToggle = document.getElementById('detailsToggle');
  const detailsDrawer = document.getElementById('detailsDrawer');
  const detailsList = document.getElementById('detailsList');

  // Privacy Evidence Elements (Phase 3B/3C)
  const privacyEvidenceSection = document.getElementById('privacyEvidenceSection');
  const evidenceLoading = document.getElementById('evidenceLoading');
  const evidenceEmpty = document.getElementById('evidenceEmpty');
  const evidenceEmptyText = document.getElementById('evidenceEmptyText');
  const evidenceEmptySubtext = document.getElementById('evidenceEmptySubtext');
  const evidenceImageWrapper = document.getElementById('evidenceImageWrapper');
  const sanitizedScreenshotImg = document.getElementById('sanitizedScreenshotImg');
  const evidenceOverlayToggleRow = document.getElementById('evidenceOverlayToggleRow');
  const overlayToggle = document.getElementById('overlayToggle');
  const evidenceRedactionOverlay = document.getElementById('evidenceRedactionOverlay');
  const metaBackend = document.getElementById('metaBackend');
  const metaCv = document.getElementById('metaCv');
  const metaOcr = document.getElementById('metaOcr');
  const metaRegions = document.getElementById('metaRegions');
  const metaProcessing = document.getElementById('metaProcessing');
  const metaGeneration = document.getElementById('metaGeneration');
  const metaProvider = document.getElementById('metaProvider');
  const metaModel = document.getElementById('metaModel');
  const metaVision = document.getElementById('metaVision');
  const metaGrounded = document.getElementById('metaGrounded');
  const metaActionTarget = document.getElementById('metaActionTarget');
  const metaAgent = document.getElementById('metaAgent');
  const badgeVisionAttached = document.getElementById('badgeVisionAttached');
  const visionModelNotice = document.getElementById('visionModelNotice');
  const evidenceStatusBadge = document.getElementById('evidenceStatusBadge');

  // Status Indicator
  const headerStatusDot = document.querySelector('.header-status-dot');
  const headerStatusLabel = document.querySelector('.header-status-label');

  // State
  let currentContext = null;
  let currentMapping = null;
  let currentDetectionCount = 0;
  let isAwaitingResponse = false;
  let currentTabId = null;
  let currentGeneration = null;
  let currentNavigationIdentity = null;
  let pendingRequestTabId = null;
  let pendingRequestGeneration = null;
  let pendingConfirmationAction = null;
  let contextUpdatedAt = 0;
  let statusInterval = null;
  let currentSidebarState = null;
  let currentSidebarMessage = null;
  let currentVisualState = null;
  let currentModelConfig = null;

  // ── 0. Sidebar Status Machine ──
  function setSidebarState(state, message = '') {
    if (state === currentSidebarState && message === currentSidebarMessage) {
      return; // Debounce duplicate state transitions
    }
    logger.log('CTX STATE', `tab=${currentTabId} generation=${currentGeneration} old=${currentSidebarState} new=${state} msg="${message}"`);
    currentSidebarState = state;
    currentSidebarMessage = message;

    if (headerStatusLabel) {
      if (state === 'READY') {
        headerStatusDot.style.background = 'var(--success)';
        updateReadyTime();
        if (!statusInterval) {
          statusInterval = setInterval(updateReadyTime, 10000);
        }
        logger.log('CHAT', 'enabled');
      } else {
        clearInterval(statusInterval);
        statusInterval = null;
        headerStatusLabel.textContent = message;
        headerStatusLabel.textContent = message;
        if (state === 'ERROR' || state === 'CONTEXT_UNAVAILABLE') {
          headerStatusDot.style.background = 'var(--danger)';
        } else if (state === 'UPDATING_CONTEXT' || state === 'READING_PAGE' || state === 'WAITING_FOR_MODEL' || state === 'THINKING' || state === 'VALIDATING' || state === 'EXECUTING') {
          headerStatusDot.style.background = 'var(--warning)';
        } else if (state === 'PROTECTING') {
          headerStatusDot.style.background = 'var(--accent)';
        } else {
          headerStatusDot.style.background = 'var(--accent)';
        }
      }
    }
    logger.log('SIDEBAR', `State transition: ${state}`, { message });
    if (typeof logGlobalState === 'function') logGlobalState();
  }

  function updateReadyTime() {
    if (!contextUpdatedAt || !headerStatusLabel) return;
    const diff = Math.floor((performance.now() - contextUpdatedAt) / 1000);
    if (diff < 5) {
      headerStatusLabel.textContent = '✓ Ready (just now)';
    } else if (diff < 60) {
      headerStatusLabel.textContent = `✓ Ready (${diff}s ago)`;
    } else {
      const mins = Math.floor(diff / 60);
      headerStatusLabel.textContent = `✓ Ready (${mins}m ago)`;
    }
  }

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

  // ── 1. Context Sync with Background ──
  function fetchLatestContext() {
    logger.log('SIDEBAR', 'initialized'); // SIDEBAR_INIT
    logger.log('CTX TRACE 01', 'sidebar -> GET_LATEST_CONTEXT');
    setSidebarState('INITIALIZING', 'Initializing...');
    chrome.runtime.sendMessage({ type: 'GET_LATEST_CONTEXT' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setSidebarState('CONTEXT_UNAVAILABLE', 'Context unavailable');
        showVisualUnavailableState('Could not retrieve context from browser.');
        return;
      }
      if (typeof response.tabId === 'number') currentTabId = response.tabId;
      if (typeof response.generation === 'number') currentGeneration = response.generation;
      if (response.navigationIdentity) currentNavigationIdentity = response.navigationIdentity;
      pendingRequestTabId = null;
      pendingRequestGeneration = null;
      cancelPendingConfirmation();

      if (response.status === 'UNSUPPORTED_URL' || isRestrictedUrl(response.navigationIdentity)) {
        setSidebarState('CONTEXT_UNAVAILABLE', response.statusMessage || 'Browser page — assistant unavailable on this page');
        showVisualUnavailableState('Assistant unavailable on browser system pages.');
        return;
      }

      if (response.status === 'CONTENT_UNAVAILABLE') {
        setSidebarState('CONTEXT_UNAVAILABLE', response.statusMessage || 'Page context unavailable. Refresh the page to reconnect');
        showVisualUnavailableState('Page context unavailable.');
        return;
      }

      if (response.sanitizedContext) {
        updateContext(response.sanitizedContext, response.detectionCount, response.mapping, response.isValid);
        if (response.isValid === false) {
          setSidebarState('READING_PAGE', 'Refreshing protected context…');
        }
      } else {
        setSidebarState('READING_PAGE', 'Reading page...');
      }
      if (response.visual) {
        updateVisualEvidence(response.visual);
      } else {
        showVisualLoadingState();
      }
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    logger.log('SIDEBAR', `MESSAGE_RECEIVED type=${message.type} tabId=${message.tabId} generation=${message.generation} currentTabId=${currentTabId}`);

    if (message.type === 'VISUAL_CONTEXT_UPDATE') {
      logger.log('SIDEBAR', `VISUAL_CONTEXT_UPDATE received tabId=${message.tabId} generation=${message.generation}`);
      // Stale generation protection: discard if tab or generation doesn't match current active
      if (message.tabId && currentTabId && message.tabId !== currentTabId) return;
      if (typeof message.generation === 'number' && typeof currentGeneration === 'number') {
        if (message.generation !== currentGeneration) {
          logger.log('SIDEBAR', `Stale VISUAL_CONTEXT_UPDATE discarded (msg gen ${message.generation} !== current ${currentGeneration})`);
          return;
        }
      }
      updateVisualEvidence(message.visual);
      return;
    }

    if (message.type === 'AGENT_STATUS_UPDATE') {
      if (metaAgent) {
        metaAgent.textContent = message.status || 'Idle';
      }
      return false;
    }

    if (message.type === 'MODEL_CONFIG_UPDATE') {
      currentModelConfig = message.config;
      updateProviderEvidence();
      return;
    }

    if (message.type === 'CONTEXT_INVALIDATED') {
      const reason = message.reason || 'unknown';
      const isNavigation = reason.includes('navigation') || reason.includes('tab_');

      currentTabId = message.tabId || null;
      currentGeneration = message.generation || null;
      currentNavigationIdentity = message.navigationIdentity || null;
      pendingRequestTabId = null;
      pendingRequestGeneration = null;
      cancelPendingConfirmation();

      if (isNavigation) {
        currentContext = null;
        currentDetectionCount = 0;
        currentMapping = null;
        currentVisualState = null;
        showLoadingState();
        showVisualLoadingState();
        setSidebarState('READING_PAGE', 'Page changed — refreshing protected context…');
      } else {
        // For in-place refreshes (e.g. manual refresh), keep existing context usable
        // but indicate we are refreshing.
        setSidebarState('READING_PAGE', 'Refreshing protected context…');
      }
      return;
    }
    if (message.type === 'CONTEXT_UPDATE') {
      logger.log('CTX TRACE 17', 'sidebar received CONTEXT_READY');
      logger.log('SIDEBAR', `CONTEXT_READY_RECEIVED generation=${message.generation} currentGeneration=${currentGeneration} contextValid=${!!message.sanitizedContext}`);
      if (typeof message.tabId === 'number') currentTabId = message.tabId;
      if (typeof message.generation === 'number') currentGeneration = message.generation;
      if (message.navigationIdentity) currentNavigationIdentity = message.navigationIdentity;

      if (message.status === 'CONTENT_UNAVAILABLE' || message.status === 'UNSUPPORTED_URL' || message.status === 'TIMEOUT') {
        const msg = message.statusMessage || (message.status === 'UNSUPPORTED_URL'
          ? 'Browser page — assistant unavailable on this page'
          : 'Page context unavailable. Refresh the page to reconnect');
        setSidebarState('CONTEXT_UNAVAILABLE', msg);
        showVisualUnavailableState(msg);
        return;
      }

      updateContext(message.sanitizedContext, message.detectionCount, message.mapping);
      if (message.visual) {
        updateVisualEvidence(message.visual);
      }
    }
  });

  // ── Visual Processing Evidence State Machine (Phase 3B/3C/3D) ──
  function showVisualLoadingState() {
    currentVisualState = null;
    if (evidenceLoading) evidenceLoading.style.display = 'flex';
    if (evidenceEmpty) evidenceEmpty.style.display = 'none';
    if (evidenceImageWrapper) evidenceImageWrapper.style.display = 'none';
    if (sanitizedScreenshotImg) sanitizedScreenshotImg.src = '';
    if (evidenceOverlayToggleRow) evidenceOverlayToggleRow.style.display = 'none';
    if (evidenceRedactionOverlay) {
      evidenceRedactionOverlay.style.display = 'none';
      evidenceRedactionOverlay.innerHTML = '';
    }
    if (metaGeneration) metaGeneration.textContent = currentGeneration ? `G${currentGeneration}` : '—';
    if (evidenceStatusBadge) evidenceStatusBadge.textContent = 'Processing';
    updateProviderEvidence();
  }

  function showVisualUnavailableState(reason = 'No sanitized image was produced.') {
    currentVisualState = null;
    if (evidenceLoading) evidenceLoading.style.display = 'none';
    if (evidenceEmpty) evidenceEmpty.style.display = 'flex';
    if (evidenceEmptyText) evidenceEmptyText.textContent = 'Visual sanitization unavailable';
    if (evidenceEmptySubtext) evidenceEmptySubtext.textContent = reason;
    if (evidenceImageWrapper) evidenceImageWrapper.style.display = 'none';
    if (sanitizedScreenshotImg) sanitizedScreenshotImg.src = '';
    if (evidenceOverlayToggleRow) evidenceOverlayToggleRow.style.display = 'none';
    if (evidenceRedactionOverlay) {
      evidenceRedactionOverlay.style.display = 'none';
      evidenceRedactionOverlay.innerHTML = '';
    }
    if (metaBackend) metaBackend.textContent = 'unavailable';
    if (metaCv) {
      metaCv.textContent = 'Failed';
      metaCv.className = 'meta-value meta-inactive';
    }
    if (metaOcr) {
      metaOcr.textContent = 'Not executed';
      metaOcr.className = 'meta-value meta-inactive';
    }
    if (metaRegions) metaRegions.textContent = '0 detected';
    if (metaProcessing) metaProcessing.textContent = '—';
    if (metaGeneration) metaGeneration.textContent = currentGeneration ? `G${currentGeneration}` : '—';
    if (evidenceStatusBadge) evidenceStatusBadge.textContent = 'Unavailable';
    updateProviderEvidence();
  }

  function updateVisualEvidence(visual) {
    if (!visual) {
      showVisualUnavailableState('No visual evidence available for current page.');
      return;
    }

    if (visual.status === 'waiting') {
      showVisualLoadingState();
      return;
    }

    if (!visual.available || !visual.sanitizedDataUrl || visual.backend === 'unavailable') {
      showVisualUnavailableState(visual.error ? `Error: ${visual.error}` : 'No sanitized image was produced.');
      return;
    }

    // Success state: display sanitized image and metadata ONLY
    currentVisualState = visual;

    if (evidenceLoading) evidenceLoading.style.display = 'none';
    if (evidenceEmpty) evidenceEmpty.style.display = 'none';
    if (evidenceImageWrapper) evidenceImageWrapper.style.display = 'flex';

    if (sanitizedScreenshotImg) {
      sanitizedScreenshotImg.src = visual.sanitizedDataUrl;
    }

    if (evidenceStatusBadge) {
      evidenceStatusBadge.textContent = 'Sanitized';
    }

    if (metaBackend) {
      metaBackend.textContent = visual.backend === 'mediapipe' ? 'MediaPipe' : (visual.backend || 'MediaPipe');
    }

    if (metaCv) {
      metaCv.textContent = visual.cvExecuted ? 'Executed' : 'Not executed';
      metaCv.className = visual.cvExecuted ? 'meta-value meta-active' : 'meta-value meta-inactive';
    }

    if (metaOcr) {
      if (visual.ocrExecuted) {
        metaOcr.textContent = 'Executed';
        metaOcr.className = 'meta-value meta-active';
      } else if (visual.ocrAvailable === false) {
        metaOcr.textContent = 'Unavailable';
        metaOcr.className = 'meta-value meta-inactive';
      } else {
        metaOcr.textContent = 'Not executed';
        metaOcr.className = 'meta-value meta-inactive';
      }
    }

    if (metaRegions) {
      const count = visual.detectionCount || (Array.isArray(visual.detections) ? visual.detections.length : 0);
      metaRegions.textContent = `${count} detected`;
    }

    if (metaProcessing) {
      metaProcessing.textContent = visual.processingMs ? `${visual.processingMs.toFixed(1)} ms` : '—';
    }

    if (metaGeneration) {
      metaGeneration.textContent = visual.generation ? `G${visual.generation}` : (currentGeneration ? `G${currentGeneration}` : '—');
    }

    if (metaGrounded) {
      const groundedCount = currentContext?.elements?.length || 0;
      metaGrounded.textContent = `${groundedCount} grounded`;
    }

    // Optional Redaction Overlay Toggle
    if (Array.isArray(visual.detections) && visual.detections.length > 0 && evidenceOverlayToggleRow) {
      evidenceOverlayToggleRow.style.display = 'flex';
      renderRedactionOverlay(visual.detections);
    } else if (evidenceOverlayToggleRow) {
      evidenceOverlayToggleRow.style.display = 'none';
    }

    updateProviderEvidence();
    if (typeof refreshContextViewData === 'function') refreshContextViewData();
    logger.log('SIDEBAR', `visual evidence updated: backend=${visual.backend} detections=${visual.detectionCount || 0} gen=${visual.generation}`);
  }

  function loadModelConfig() {
    chrome.runtime.sendMessage({ type: 'MODEL_GET_CONFIG' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      currentModelConfig = response;
      updateProviderEvidence();
    });
  }

  function updateProviderEvidence() {
    if (!metaProvider || !metaModel || !metaVision) return;
    const providerId = currentModelConfig?.selectedProvider || '';
    const modelId = currentModelConfig?.selectedModel || '';
    const isConfigured = Boolean(providerId && currentModelConfig?.providers?.[providerId]?.configured);

    if (!isConfigured) {
      metaProvider.textContent = 'None (Mock)';
      metaModel.textContent = 'Deterministic';
      metaVision.textContent = 'Disabled';
      metaVision.className = 'meta-value meta-inactive';
      if (badgeVisionAttached) badgeVisionAttached.style.display = 'none';
      if (visionModelNotice) visionModelNotice.style.display = 'none';
      return;
    }

    const providerNames = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', local: 'Local' };
    metaProvider.textContent = providerNames[providerId] || providerId;
    metaModel.textContent = modelId ? (modelId.includes('/') ? modelId.split('/').pop() : modelId) : 'default';

    // Check vision capabilities
    let isVision = false;
    if (providerId === 'gemini') {
      const lower = String(modelId).toLowerCase();
      isVision = !lower.includes('embedding') && !lower.includes('aqa') && !lower.includes('text-only') && lower.includes('gemini');
    }

    if (headerSelectedModel) {
      const displayModel = modelId ? (modelId.includes('/') ? modelId.split('/').pop() : modelId) : (isConfigured ? 'Gemini 2.5 Flash' : 'Deterministic');
      headerSelectedModel.textContent = displayModel;
    }

    if (isVision) {
      metaVision.textContent = 'Enabled';
      metaVision.className = 'meta-value meta-active';
      const hasSanitizedImage = Boolean(currentVisualState && currentVisualState.available && currentVisualState.sanitizedDataUrl);
      if (hasSanitizedImage) {
        if (badgeVisionAttached) badgeVisionAttached.style.display = 'inline-flex';
        if (visionModelNotice) visionModelNotice.style.display = 'none';
      } else {
        if (badgeVisionAttached) badgeVisionAttached.style.display = 'none';
        if (visionModelNotice) visionModelNotice.style.display = 'none';
      }
    } else {
      metaVision.textContent = 'Not supported';
      metaVision.className = 'meta-value meta-inactive';
      if (badgeVisionAttached) badgeVisionAttached.style.display = 'none';
      if (visionModelNotice) {
        visionModelNotice.style.display = 'block';
        visionModelNotice.textContent = 'Sanitized image not sent — selected model does not support vision.';
      }
    }
  }

  function renderRedactionOverlay(detections) {
    if (!evidenceRedactionOverlay) return;
    evidenceRedactionOverlay.innerHTML = '';
    // Optional overlay boxes (geometry only, never PII values)
    for (const d of detections) {
      const box = d.rect || d.bbox || (typeof d.x === 'number' ? d : null);
      if (!box || typeof box.x !== 'number') continue;
      const el = document.createElement('div');
      el.className = 'evidence-overlay-box';
      el.title = `Redacted region: ${formatTypeName(d.type)}`;
      // Position relative to image container if normalized or sized
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
      evidenceRedactionOverlay.appendChild(el);
    }
  }

  if (overlayToggle && evidenceRedactionOverlay) {
    overlayToggle.addEventListener('change', () => {
      evidenceRedactionOverlay.style.display = overlayToggle.checked ? 'block' : 'none';
    });
  }

  function logGlobalState() {
    logger.log('STATE', `
tabId=${currentTabId}
generation=${currentGeneration}
textContext=${currentContext ? 'READY' : 'NULL'}
contextValid=${!!currentContext}
assistantState=${headerStatusLabel.textContent}
chatEnabled=${sendBtn ? !sendBtn.disabled : 'unknown'}
`);
  }

  function updateContext(context, detectionCount, mapping, isValid = true) {
    logger.log('CTX TRACE 18', 'currentContext assigned');
    currentContext = context;
    currentDetectionCount = detectionCount || 0;
    currentMapping = mapping || null;

    if (refreshBtn) refreshBtn.classList.remove('spinning');
    logGlobalState();
    if (typeof refreshContextViewData === 'function') refreshContextViewData();

    if (context) {
      contextUpdatedAt = performance.now();
      if (isValid) {
        setSidebarState('PROTECTING', 'Finalizing protection...');
        setTimeout(() => {
          logger.log('CTX TRACE 19', 'sidebar READY transition');
          logger.log('SIDEBAR', 'SETTING_READY');
          setSidebarState('READY');
          logger.log('CTX TRACE 20', 'chat input enabled');
          logger.log('CHAT', `INPUT_ENABLED reason=TEXT_CONTEXT_READY generation=${currentGeneration}`);
          logger.log('SIDEBAR', 'READY_SET');
        }, 300);
      }
      renderSecurityContext();
    } else {
      setSidebarState('READING_PAGE', 'Reading page...');
      renderSecurityContext();
    }
  }

  function showLoadingState() {
    if (securityBanner) securityBanner.style.display = 'block';
    if (securityNoticeText) securityNoticeText.textContent = 'Loading current page…';
    if (detailsDrawer) detailsDrawer.style.display = 'none';
    if (detailsToggle) detailsToggle.textContent = 'Protection details +';
    if (detailsList) detailsList.innerHTML = '';
  }

  function renderSecurityContext() {
    if (!securityBanner) return;
    if (!currentContext) {
      if (securityBanner.style.display === 'none') {
        securityBanner.style.display = 'block';
        securityNoticeText.textContent = 'Loading current page…';
      }
      return;
    }
    if (currentDetectionCount > 0) {
      securityBanner.style.display = 'block';
      const label = currentDetectionCount === 1
        ? '1 sensitive item protected locally'
        : `${currentDetectionCount} sensitive items protected locally`;
      securityNoticeText.textContent = label;

      if (Array.isArray(currentMapping) && currentMapping.length > 0) {
        let html = '';
        for (const meta of currentMapping) {
          const typeName = formatTypeName(meta.type);
          const maskType = meta.type === 'email' ? 'Redacted' : 'Masked';
          html += `
            <div class="details-row">
              <span class="details-type">${escapeHtml(typeName)}</span>
              <span class="details-badge">${escapeHtml(maskType)}</span>
            </div>
          `;
        }
        detailsList.innerHTML = html;
      } else {
        detailsList.innerHTML = `
          <div class="details-row">
            <span class="details-type">Sensitive content</span>
            <span class="details-badge">Protected</span>
          </div>
        `;
      }
    } else {
      securityBanner.style.display = 'none';
      detailsDrawer.style.display = 'none';
    }
  }

  function formatTypeName(rawType) {
    if (!rawType) return 'Sensitive item';
    const clean = rawType.replace(/_/g, ' ').toLowerCase();
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }

  if (detailsToggle) {
    detailsToggle.addEventListener('click', () => {
      const isHidden = detailsDrawer.style.display === 'none';
      detailsDrawer.style.display = isHidden ? 'block' : 'none';
      detailsToggle.textContent = isHidden ? 'Protection details −' : 'Protection details +';
    });
  }

  // ── Refresh Context ──
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (refreshBtn.classList.contains('spinning')) return;
      if (!currentTabId) return;

      logger.log('SIDEBAR', 'Requesting context refresh');
      setSidebarState('UPDATING_CONTEXT', 'Updating context...');
      refreshBtn.classList.add('spinning');

      chrome.runtime.sendMessage({ type: 'REQUEST_CONTEXT_REFRESH', tabId: currentTabId }, (res) => {
        if (chrome.runtime.lastError) {
          logger.error('SIDEBAR', 'refreshContext', chrome.runtime.lastError);
          setSidebarState('ERROR', 'Context update failed');
          refreshBtn.classList.remove('spinning');
        }
        // Background handles the rest via CONTEXT_INVALIDATED -> CONTEXT_UPDATE
      });
    });
  }

  // ── Settings Modal & Options ──
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      if (settingsModal) {
        settingsModal.style.display = 'flex';
      } else {
        chrome.runtime.openOptionsPage();
      }
    });
  }

  if (closeSettingsModalBtn) {
    closeSettingsModalBtn.addEventListener('click', () => {
      if (settingsModal) settingsModal.style.display = 'none';
    });
  }

  if (settingsModalBackdrop) {
    settingsModalBackdrop.addEventListener('click', () => {
      if (settingsModal) settingsModal.style.display = 'none';
    });
  }

  if (openFullOptionsBtn) {
    openFullOptionsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // ── Tab Switching Navigation (Phase 13) ──
  function switchTab(tabName) {
    const tabMap = {
      chat: { tab: tabChat, view: chatView },
      context: { tab: tabContext, view: contextView },
      privacy: { tab: tabPrivacy, view: privacyView }
    };

    for (const [name, entry] of Object.entries(tabMap)) {
      if (!entry.tab || !entry.view) continue;
      const isActive = (name === tabName);
      entry.tab.classList.toggle('active', isActive);
      entry.tab.setAttribute('aria-selected', String(isActive));
      entry.view.style.display = isActive ? 'flex' : 'none';
      entry.view.classList.toggle('active', isActive);
    }

    if (tabName === 'context') {
      refreshContextViewData();
    }
  }

  if (tabChat) tabChat.addEventListener('click', () => switchTab('chat'));
  if (tabContext) tabContext.addEventListener('click', () => switchTab('context'));
  if (tabPrivacy) tabPrivacy.addEventListener('click', () => switchTab('privacy'));
  if (chatPrivacyBadge) chatPrivacyBadge.addEventListener('click', () => switchTab('privacy'));

  // ── Model Selector ──
  function loadModelConfig() {
    chrome.runtime.sendMessage({ type: 'MODEL_GET_CONFIG' }, (config) => {
      if (chrome.runtime.lastError || !config) return;
      if (!modelSelect) return;

      if (headerSelectedModel) {
        const modelId = config.selectedModel || '';
        const displayModel = modelId ? (modelId.includes('/') ? modelId.split('/').pop() : modelId) : 'Gemini 2.5 Flash';
        headerSelectedModel.textContent = displayModel;
      }

      modelSelect.replaceChildren();
      let hasSelection = false;

      for (const [providerId, providerData] of Object.entries(config.providers || {})) {
        if (providerData.configured && providerData.models && providerData.models.length > 0) {
          const optgroup = document.createElement('optgroup');
          optgroup.label = providerId.toUpperCase();
          for (const model of providerData.models) {
            const option = document.createElement('option');
            option.value = `${providerId}::${model.id}`;
            option.textContent = model.name || model.id;
            optgroup.appendChild(option);

            if (config.selectedProvider === providerId && config.selectedModel === model.id) {
              option.selected = true;
              hasSelection = true;
            }
          }
          modelSelect.appendChild(optgroup);
        }
      }

      if (!hasSelection) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Select a model...';
        option.selected = true;
        modelSelect.insertBefore(option, modelSelect.firstChild);
      }
    });
  }

  if (modelSelect) {
    modelSelect.addEventListener('change', () => {
      const val = modelSelect.value;
      if (!val) return;
      const [providerId, modelId] = val.split('::');
      logger.log('SIDEBAR', 'User changed model', { providerId, modelId });

      chrome.runtime.sendMessage({
        type: 'MODEL_SAVE_CONFIG',
        config: {
          selectedProvider: providerId,
          selectedModel: modelId
        }
      });
    });
  }

  // ── User Suggestions ──
  document.querySelectorAll('.suggestion-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt && !isAwaitingResponse) {
        handleUserPrompt(prompt);
      }
    });
  });

  // ── Input Handling ──
  if (userInput) {
    userInput.addEventListener('input', () => {
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
      if (sendBtn) sendBtn.disabled = !userInput.value.trim() || isAwaitingResponse;
    });

    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = userInput.value.trim();
        if (text && !isAwaitingResponse) {
          handleUserPrompt(text);
        }
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      const text = userInput.value.trim();
      if (text && !isAwaitingResponse) {
        handleUserPrompt(text);
      }
    });
  }

  // ── Prompt Processing Flow ──
  async function handleUserPrompt(promptText) {
    if (isAwaitingResponse) return;

    if (!currentContext || currentGeneration == null) {
      appendAssistantMessage('Page context is loading or invalid. Please wait for the page to be analyzed.');
      return;
    }

    if (emptyState && emptyState.style.display !== 'none') {
      emptyState.style.display = 'none';
      if (conversationStream) conversationStream.style.display = 'flex';
    }

    const requestTabId = currentTabId;
    const requestGeneration = currentGeneration;
    const requestNavIdentity = currentNavigationIdentity;
    pendingRequestTabId = requestTabId;
    pendingRequestGeneration = requestGeneration;

    appendUserMessage(promptText);
    if (userInput) {
      userInput.value = '';
      userInput.style.height = 'auto';
    }
    if (sendBtn) sendBtn.disabled = true;
    isAwaitingResponse = true;

    setSidebarState('WAITING_FOR_MODEL', 'Waiting for model...');
    const loadingEl = appendLoadingIndicator();

    logger.log('CHAT', `request generation=${requestGeneration} contextValid=${!!currentContext}`);

    try {
      const response = await sendToBackend(promptText, requestTabId, requestGeneration, requestNavIdentity);
      loadingEl.remove();

      if (
        currentTabId !== requestTabId ||
        currentGeneration !== requestGeneration ||
        pendingRequestGeneration !== requestGeneration
      ) {
        logger.log('SIDEBAR', 'Stale chat response discarded', { requestGeneration, currentGeneration });
        return;
      }

      setSidebarState('READY');

      if (!response) {
        appendAssistantMessage('The AI provider could not process this request. Your page data remained protected locally.');
        return;
      }

      if (response.error) {
        if (response.errorCode === 'PROVIDER_UNAVAILABLE') {
          appendAssistantMessage('Model configuration needs attention. Open Settings to review it.');
        } else {
          appendAssistantMessage('The AI provider could not process this request. Your page data remained protected locally.');
        }
        return;
      }

      if (response.isMock) {
        if (response.type === 'text') {
          appendAssistantMessage((response.message || '') + '\n\n⚠️ *Mock response — configure a provider in Settings for real AI.*');
        } else if (response.type === 'action' && response.action) {
          await handleActionProposal(response.action, true, requestGeneration, requestNavIdentity);
        }
        return;
      }

      if (response.type === 'action' && response.action) {
        await handleActionProposal(response.action, false, requestGeneration, requestNavIdentity);
      } else if (response.type === 'text' || response.message) {
        appendAssistantMessage(response.message || 'Understood.');
      } else {
        appendAssistantMessage('Received unexpected response format.');
      }
    } catch (err) {
      loadingEl.remove();
      appendAssistantMessage(`Unable to connect: ${err.message}`);
      setSidebarState('ERROR', 'Error occurred');
    } finally {
      isAwaitingResponse = false;
      if (sendBtn) sendBtn.disabled = !userInput.value.trim();
      if (userInput) userInput.focus();
    }
  }

  function sendToBackend(userMessage, tabId, generation, navigationIdentity) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'SEND_TO_BACKEND',
          userMessage: userMessage,
          sanitizedContext: currentContext,
          tabId,
          generation,
          navigationIdentity
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  // ── Message Rendering ──
  function appendUserMessage(text) {
    if (!conversationStream) return;
    const group = document.createElement('div');
    group.className = 'message-group user-group';
    group.innerHTML = `
      <div class="message-role role-user">You</div>
      <div class="message-body"><p>${escapeHtml(text)}</p></div>
    `;
    conversationStream.appendChild(group);
    scrollToBottom();
  }

  function appendLoadingIndicator() {
    if (!conversationStream) return { remove: () => { } };
    const group = document.createElement('div');
    group.className = 'message-group assistant-group';
    group.innerHTML = `
      <div class="message-role role-assistant">Assistant</div>
      <div class="message-body"><div class="streaming-indicator"><div class="streaming-dot"></div><div class="streaming-dot"></div><div class="streaming-dot"></div></div></div>
    `;
    conversationStream.appendChild(group);
    scrollToBottom();
    return group;
  }

  function appendAssistantMessage(text) {
    if (!conversationStream) return;
    const group = document.createElement('div');
    group.className = 'message-group assistant-group';
    group.innerHTML = `
      <div class="message-role role-assistant">Assistant</div>
      <div class="message-body">${formatMarkdown(text)}</div>
    `;
    conversationStream.appendChild(group);
    scrollToBottom();
  }

  // ── Action Confirmation Policy & Execution ──
  function classifyActionRisk(action) {
    const act = action.action?.toLowerCase();
    if (act === 'scroll') return 'SAFE';
    // Type into password is BLOCKED by validate.js anyway, but we can catch here too.
    if (act === 'type' && (action.target || '').includes('password')) return 'BLOCKED';

    // Default to CONFIRM_REQUIRED for any click or type
    return 'CONFIRM_REQUIRED';
  }

  async function handleActionProposal(action, isMock = false, generation = null, navIdentity = null) {
    const risk = classifyActionRisk(action);
    logger.log('ACTION', `Action proposed: ${action.action}`, { risk, target: action.target });

    if (metaActionTarget) {
      metaActionTarget.textContent = action.target || action.elementId || 'None';
    }

    if (risk === 'BLOCKED') {
      appendAssistantMessage(`Action blocked by security policy: cannot execute \`${action.action}\` on \`${action.target}\`.`);
      return;
    }

    if (risk === 'CONFIRM_REQUIRED') {
      requestActionConfirmation(action, generation, navIdentity);
      return;
    }

    // SAFE action, execute immediately
    await executeActionInBrowser(action, generation);
  }

  function requestActionConfirmation(action, generation, navIdentity) {
    if (!confirmationDialog) return;
    setSidebarState('WAITING_FOR_CONFIRMATION', 'Waiting for confirmation...');

    pendingConfirmationAction = { action, generation, navIdentity };

    confirmActionDesc.textContent = `${action.action} on element \`${action.target}\``;
    if (action.value) {
      confirmActionDesc.textContent += ` with value "${action.value}"`;
    }

    try {
      const url = new URL(navIdentity);
      confirmDomain.textContent = `Website: ${url.hostname}`;
    } catch (e) {
      confirmDomain.textContent = `Context: current page`;
    }

    confirmationDialog.style.display = 'block';
    scrollToBottom();
  }

  function cancelPendingConfirmation() {
    if (confirmationDialog) confirmationDialog.style.display = 'none';
    pendingConfirmationAction = null;
    setSidebarState('READY');
  }

  if (confirmCancelBtn) {
    confirmCancelBtn.addEventListener('click', () => {
      logger.log('SECURITY', 'User denied action');
      cancelPendingConfirmation();
      appendAssistantMessage('Action cancelled.');
    });
  }

  if (confirmAllowBtn) {
    confirmAllowBtn.addEventListener('click', async () => {
      if (!pendingConfirmationAction) return;
      const { action, generation, navIdentity } = pendingConfirmationAction;

      // Verify identity hasn't changed
      if (generation !== currentGeneration || navIdentity !== currentNavigationIdentity) {
        logger.warn('SECURITY', 'Action confirmation rejected due to stale identity');
        appendAssistantMessage('Action cancelled: the page context has changed.');
        cancelPendingConfirmation();
        return;
      }

      logger.log('SECURITY', 'User approved action', { action: action.action });
      cancelPendingConfirmation();
      await executeActionInBrowser(action, generation);
    });
  }

  async function executeActionInBrowser(action, generation) {
    const group = document.createElement('div');
    group.className = 'message-group assistant-group';
    group.innerHTML = `
      <div class="message-role role-assistant">Assistant</div>
      <div class="message-body">
        <div class="action-receipt">
          <div class="action-row">
            <span class="action-label">Action:</span>
            <span class="action-type">${escapeHtml(action.action || '')}</span>
          </div>
          <div class="action-row">
            <span class="action-label">Target:</span>
            <span class="action-target">${escapeHtml(action.target || 'None')}</span>
          </div>
          ${action.value ? `<div class="action-row"><span class="action-label">Value:</span><span>${escapeHtml(action.value)}</span></div>` : ''}
          <div class="action-status" id="actionStatus">Executing in browser...</div>
        </div>
      </div>
    `;
    if (conversationStream) conversationStream.appendChild(group);
    scrollToBottom();

    const statusEl = group.querySelector('#actionStatus');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        statusEl.className = 'action-status failed';
        statusEl.textContent = '● Failed: No active tab found.';
        return;
      }

      const actionPayload = {
        ...action,
        generation: generation || currentGeneration
      };

      chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action: actionPayload }, (res) => {
        if (chrome.runtime.lastError) {
          statusEl.className = 'action-status failed';
          statusEl.textContent = `● Failed: ${chrome.runtime.lastError.message}`;
          logger.error('ACTION', 'Execution error', chrome.runtime.lastError);
        } else if (res && res.success) {
          statusEl.className = 'action-status success';
          statusEl.textContent = '● Executed safely in browser';
          logger.log('ACTION', 'Execution successful');
        } else {
          statusEl.className = 'action-status failed';
          statusEl.textContent = `● Failed: ${res?.error || 'Validation rejected action.'}`;
          logger.warn('ACTION', 'Execution failed or rejected', { error: res?.error });
        }
      });
    } catch (e) {
      statusEl.className = 'action-status failed';
      statusEl.textContent = `● Error: ${e.message}`;
      logger.error('ACTION', 'Execution exception', e);
    }
  }

  function scrollToBottom() {
    const main = document.querySelector('.sidebar-main');
    if (main) main.scrollTop = main.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMarkdown(text) {
    if (!text) return '';
    let html = escapeHtml(text);
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    const paragraphs = html.split(/\n\n+/);
    return paragraphs.map((p) => {
      const trimmed = p.trim();
      if (trimmed.startsWith('<pre>')) return trimmed;
      if (trimmed.includes(' - ') && !trimmed.includes('\n')) {
        const parts = trimmed.split(/\s+-\s+/);
        const intro = parts[0];
        const items = parts.slice(1).map(item => `<li>${item.trim()}</li>`).join('');
        return (intro ? `<p>${intro}</p>` : '') + `<ul>${items}</ul>`;
      }
      if (trimmed.includes('\n•') || trimmed.includes('\n-') || trimmed.startsWith('•') || trimmed.startsWith('-')) {
        const lines = trimmed.split('\n');
        const listItems = lines.map((l) => {
          const clean = l.replace(/^[•\-*]\s*/, '').trim();
          return clean ? `<li>${clean}</li>` : '';
        }).join('');
        return `<ul>${listItems}</ul>`;
      }
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      logger.log('SIDEBAR', 'refresh clicked');
      setSidebarState('READING_PAGE', 'Refreshing protected context…');
      chrome.runtime.sendMessage({ type: 'REQUEST_CONTEXT_REFRESH', tabId: currentTabId }, () => {
        fetchLatestContext();
      });
    });
  }

  const themeToggleBtn = document.getElementById('themeToggleBtn');
  if (themeToggleBtn && window.SIH_Theme) {
    function updateThemeBtnIcon() {
      const isDark = document.documentElement.dataset.theme === 'dark';
      themeToggleBtn.innerHTML = isDark
        ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
        : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
    }
    updateThemeBtnIcon();
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      window.SIH_Theme.setTheme(next);
      updateThemeBtnIcon();
    });
  }

  const screenshotToggleEl = document.getElementById('screenshotToggle');
  const screenshotNoteEl = document.getElementById('screenshotNote');
  const SCREENSHOT_KEY = 'sihScreenshotEnabled';

  function applyScreenshotNote(enabled) {
    if (!screenshotNoteEl) return;
    if (enabled) {
      screenshotNoteEl.textContent = '✓ Captured locally · Sensitive regions redacted · Only redacted imagery leaves device';
    } else {
      screenshotNoteEl.textContent = 'Screenshot excluded from AI context';
    }
  }

  chrome.storage.local.get([SCREENSHOT_KEY], (result) => {
    const enabled = result[SCREENSHOT_KEY] !== false;
    if (screenshotToggleEl) {
      screenshotToggleEl.checked = enabled;
      screenshotToggleEl.setAttribute('aria-checked', String(enabled));
    }
    applyScreenshotNote(enabled);
  });

  if (screenshotToggleEl) {
    screenshotToggleEl.addEventListener('change', () => {
      const enabled = screenshotToggleEl.checked;
      screenshotToggleEl.setAttribute('aria-checked', String(enabled));
      chrome.storage.local.set({ [SCREENSHOT_KEY]: enabled });
      applyScreenshotNote(enabled);
    });
  }

  // ── Refresh Context View Data (Phase 13 What AI Sees) ──
  const viewContextBtn = document.getElementById('viewContextBtn');
  const sanitizedContextModal = document.getElementById('sanitizedContextModal');
  const closeContextModalBtn = document.getElementById('closeContextModalBtn');
  const seePageUrl = document.getElementById('seePageUrl');
  const seeVisualStatus = document.getElementById('seeVisualStatus');
  const seeOcrStatus = document.getElementById('seeOcrStatus');
  const seeDetectedCategories = document.getElementById('seeDetectedCategories');
  const seeElementsCount = document.getElementById('seeElementsCount');
  const seeModelInfo = document.getElementById('seeModelInfo');
  const seeVisionStatus = document.getElementById('seeVisionStatus');

  function refreshContextViewData() {
    if (seePageUrl) {
      seePageUrl.textContent = currentContext?.url || '—';
    }
    if (seeVisualStatus) {
      const hasScreenshot = Boolean(currentVisualState?.sanitizedDataUrl || currentVisualState?.available);
      seeVisualStatus.textContent = hasScreenshot ? 'Sanitized screenshot ✓' : 'Visual context omitted';
    }
    if (seeOcrStatus) {
      const ocrRan = Boolean(currentContext?.ocrRan || currentVisualState?.ocrExecuted);
      seeOcrStatus.textContent = ocrRan ? 'Executed ✓' : 'Not executed';
    }
    if (seeDetectedCategories) {
      seeDetectedCategories.replaceChildren();
      const types = new Set();
      if (currentContext?.detections && Array.isArray(currentContext.detections)) {
        for (const d of currentContext.detections) {
          if (d.type) types.add(d.type.toUpperCase());
        }
      }
      if (currentVisualState?.detections && Array.isArray(currentVisualState.detections)) {
        for (const d of currentVisualState.detections) {
          if (d.type) types.add(d.type.toUpperCase());
        }
      }
      if (types.size === 0) {
        const chip = document.createElement('span');
        chip.className = 'status-chip status-chip-coral';
        chip.textContent = '[NONE DETECTED]';
        seeDetectedCategories.appendChild(chip);
      } else {
        for (const t of types) {
          const chip = document.createElement('span');
          chip.className = 'status-chip status-chip-coral';
          chip.textContent = `[${t} REDACTED]`;
          seeDetectedCategories.appendChild(chip);
        }
      }
    }
    if (seeElementsCount) {
      const count = currentContext?.interactiveElements?.length || currentContext?.elements?.length || 0;
      seeElementsCount.textContent = `${count} interactive elements`;
    }
    if (seeModelInfo) {
      const prov = currentModelConfig?.selectedProvider || 'Gemini';
      const mod = currentModelConfig?.selectedModel || 'gemini-2.5-flash';
      const cleanMod = mod.includes('/') ? mod.split('/').pop() : mod;
      seeModelInfo.textContent = `${prov} / ${cleanMod}`;
    }
    if (seeVisionStatus) {
      const isVision = currentModelConfig?.capabilities?.vision !== false;
      seeVisionStatus.textContent = isVision ? 'Vision: Enabled' : 'Vision: Disabled';
    }
  }

  if (viewContextBtn) {
    viewContextBtn.addEventListener('click', () => {
      switchTab('context');
      refreshContextViewData();
    });
  }
  if (closeContextModalBtn) {
    closeContextModalBtn.addEventListener('click', () => {
      if (sanitizedContextModal) sanitizedContextModal.style.display = 'none';
    });
  }

  // Init
  loadModelConfig();
  fetchLatestContext();
});
