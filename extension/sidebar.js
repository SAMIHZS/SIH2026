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

  // ── 0. Sidebar Status Machine ──
  function setSidebarState(state, message = '') {
    if (headerStatusLabel) {
      if (state === 'READY') {
        headerStatusDot.style.background = 'var(--success)';
        updateReadyTime();
        if (!statusInterval) {
          statusInterval = setInterval(updateReadyTime, 10000);
        }
      } else {
        clearInterval(statusInterval);
        statusInterval = null;
        headerStatusLabel.textContent = message;
        if (state === 'ERROR' || state === 'CONTEXT_UNAVAILABLE') {
          headerStatusDot.style.background = 'var(--danger)';
        } else if (state === 'UPDATING_CONTEXT' || state === 'READING_PAGE' || state === 'WAITING_FOR_MODEL') {
          headerStatusDot.style.background = 'var(--warning)';
        } else {
          headerStatusDot.style.background = 'var(--accent)';
        }
      }
    }
    logger.log('SIDEBAR', `State transition: ${state}`, { message });
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

  // ── 1. Context Sync with Background ──
  function fetchLatestContext() {
    setSidebarState('INITIALIZING', 'Initializing...');
    chrome.runtime.sendMessage({ type: 'GET_LATEST_CONTEXT' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setSidebarState('CONTEXT_UNAVAILABLE', 'Context unavailable');
        return;
      }
      if (response.tabId) currentTabId = response.tabId;
      if (response.generation) currentGeneration = response.generation;
      if (response.navigationIdentity) currentNavigationIdentity = response.navigationIdentity;
      if (response.sanitizedContext) {
        updateContext(response.sanitizedContext, response.detectionCount, response.mapping);
      } else {
        setSidebarState('READING_PAGE', 'Reading page...');
      }
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'CONTEXT_INVALIDATED') {
      currentTabId = message.tabId || null;
      currentGeneration = message.generation || null;
      currentNavigationIdentity = message.navigationIdentity || null;
      currentContext = null;
      currentDetectionCount = 0;
      currentMapping = null;
      pendingRequestTabId = null;
      pendingRequestGeneration = null;
      cancelPendingConfirmation();
      showLoadingState();
      setSidebarState('READING_PAGE', 'Context invalidated. Reading new page...');
      return;
    }
    if (message.type === 'CONTEXT_UPDATE') {
      if (message.tabId && currentTabId && message.tabId !== currentTabId) return;
      if (message.tabId) currentTabId = message.tabId;
      if (message.generation) currentGeneration = message.generation;
      if (message.navigationIdentity) currentNavigationIdentity = message.navigationIdentity;
      updateContext(message.sanitizedContext, message.detectionCount, message.mapping);
    }
  });

  function updateContext(context, detectionCount, mapping) {
    currentContext = context;
    currentDetectionCount = detectionCount || 0;
    currentMapping = mapping || null;

    if (refreshBtn) refreshBtn.classList.remove('spinning');

    if (context) {
      contextUpdatedAt = performance.now();
      setSidebarState('READY');
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

  // ── Settings Button ──
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // ── Model Selector ──
  function loadModelConfig() {
    chrome.runtime.sendMessage({ type: 'MODEL_GET_CONFIG' }, (config) => {
      if (chrome.runtime.lastError || !config) return;
      if (!modelSelect) return;

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
        appendAssistantMessage('Unable to complete request: No response received.');
        return;
      }

      if (response.error) {
        appendAssistantMessage(`Unable to process request: ${response.error}`);
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

  const screenshotToggleEl = document.getElementById('screenshotToggle');
  const screenshotNoteEl = document.getElementById('screenshotNote');
  const SCREENSHOT_KEY = 'sihScreenshotEnabled';

  function applyScreenshotNote(enabled) {
    if (!screenshotNoteEl) return;
    if (enabled) {
      screenshotNoteEl.textContent = 'Sanitized locally · faces blurred · PII masked';
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

  // Init
  loadModelConfig();
  fetchLatestContext();
});
