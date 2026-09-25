/**
 * Minimal Assistant Sidebar Script
 */
document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const emptyState = document.getElementById('emptyState');
  const conversationStream = document.getElementById('conversationStream');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const closeBtn = document.getElementById('closeBtn');

  // Screenshot Toggle
  const screenshotToggleEl = document.getElementById('screenshotToggle');
  const screenshotNoteEl = document.getElementById('screenshotNote');
  const SCREENSHOT_KEY = 'sihScreenshotEnabled';

  // Security Context Elements
  const securityBanner = document.getElementById('securityBanner');
  const securityNoticeText = document.getElementById('securityNoticeText');
  const detailsToggle = document.getElementById('detailsToggle');
  const detailsDrawer = document.getElementById('detailsDrawer');
  const detailsList = document.getElementById('detailsList');

  // State
  let currentContext = null;
  let currentMapping = null;
  let currentDetectionCount = 0;
  let isAwaitingResponse = false;
  let currentTabId = null;            // Track which tab's context we're displaying
  let currentGeneration = null;       // Current perception generation token
  let currentNavigationIdentity = null;
  let pendingRequestTabId = null;
  let pendingRequestGeneration = null;

  // ── 1. Context Sync with Background ──
  function fetchLatestContext() {
    chrome.runtime.sendMessage({ type: 'GET_LATEST_CONTEXT' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (response.tabId) currentTabId = response.tabId;
      if (response.generation) currentGeneration = response.generation;
      if (response.navigationIdentity) currentNavigationIdentity = response.navigationIdentity;
      if (response.sanitizedContext) {
        updateContext(response.sanitizedContext, response.detectionCount, response.mapping);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'CONTEXT_INVALIDATED') {
      // Tab or page just changed — immediately invalidate and show loading state
      currentTabId = message.tabId || null;
      currentGeneration = message.generation || null;
      currentNavigationIdentity = message.navigationIdentity || null;
      currentContext = null;
      currentDetectionCount = 0;
      currentMapping = null;
      // Invalidate any in-flight chat requests for the old page
      pendingRequestTabId = null;
      pendingRequestGeneration = null;
      showLoadingState();
      return;
    }
    if (message.type === 'CONTEXT_UPDATE') {
      // Ignore updates from tabs that are no longer active
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
    if (context) {
      renderSecurityContext();
    } else {
      // Null context = page still loading or no analysis yet
      renderSecurityContext();
    }
  }

  /** Show an immediate "switching tabs" loading state in the security banner. */
  function showLoadingState() {
    securityBanner.style.display = 'block';
    securityNoticeText.textContent = 'Loading current page…';
    detailsDrawer.style.display = 'none';
    detailsToggle.textContent = 'Protection details +';
    detailsList.innerHTML = '';
  }

  function renderSecurityContext() {
    if (!currentContext) {
      // No context yet (switching tabs / loading)
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

  // Toggle details drawer
  detailsToggle.addEventListener('click', () => {
    const isHidden = detailsDrawer.style.display === 'none';
    detailsDrawer.style.display = isHidden ? 'block' : 'none';
    detailsToggle.textContent = isHidden ? 'Protection details −' : 'Protection details +';
  });

  // ── 2. User Suggestions ──
  document.querySelectorAll('.suggestion-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt && !isAwaitingResponse) {
        handleUserPrompt(prompt);
      }
    });
  });

  // ── 3. Input Handling ──
  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
    sendBtn.disabled = !userInput.value.trim() || isAwaitingResponse;
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

  sendBtn.addEventListener('click', () => {
    const text = userInput.value.trim();
    if (text && !isAwaitingResponse) {
      handleUserPrompt(text);
    }
  });

  // ── 4. Prompt Processing Flow ──
  async function handleUserPrompt(promptText) {
    if (isAwaitingResponse) return;

    // Fail closed if context is missing or loading
    if (!currentContext || currentGeneration == null) {
      appendAssistantMessage('Page context is loading or invalid. Please wait for the page to be analyzed.');
      return;
    }

    // Switch view if in empty state
    if (emptyState.style.display !== 'none') {
      emptyState.style.display = 'none';
      conversationStream.style.display = 'flex';
    }

    // Capture exact context identity for this request
    const requestTabId = currentTabId;
    const requestGeneration = currentGeneration;
    const requestNavIdentity = currentNavigationIdentity;
    pendingRequestTabId = requestTabId;
    pendingRequestGeneration = requestGeneration;

    // Append user message
    appendUserMessage(promptText);
    userInput.value = '';
    userInput.style.height = 'auto';
    sendBtn.disabled = true;
    isAwaitingResponse = true;

    // Append loading indicator
    const loadingEl = appendLoadingIndicator();

    try {
      const response = await sendToBackend(promptText, requestTabId, requestGeneration, requestNavIdentity);
      loadingEl.remove();

      // STALE CHAT RESPONSE GUARD:
      // If user switched tabs or navigated while awaiting response, DISCARD IT!
      if (
        currentTabId !== requestTabId ||
        currentGeneration !== requestGeneration ||
        pendingRequestGeneration !== requestGeneration
      ) {
        console.info(`[PRIVACY STATE] STALE CHAT RESPONSE DISCARDED: response belongs to Tab ${requestTabId} Gen ${requestGeneration}, active is Tab ${currentTabId} Gen ${currentGeneration}`);
        return;
      }

      if (!response) {
        appendAssistantMessage('Unable to complete request: No response received.');
        return;
      }

      if (response.error) {
        appendAssistantMessage(`Unable to process request: ${response.error}`);
        return;
      }

      // Clearly label mock fallback responses
      if (response.isMock) {
        if (response.type === 'text') {
          appendAssistantMessage((response.message || '') + '\n\n⚠️ *Mock response — configure a provider in Settings for real AI.*');
        } else if (response.type === 'action' && response.action) {
          await handleActionResponse(response.action, true, requestGeneration);
        } else {
          appendAssistantMessage('[MOCK] ' + (response.mockReason || 'Mock fallback response'));
        }
        return;
      }

      if (response.type === 'action' && response.action) {
        await handleActionResponse(response.action, false, requestGeneration);
      } else if (response.type === 'text' || response.message) {
        appendAssistantMessage(response.message || 'Understood.');
      } else {
        appendAssistantMessage('Received unexpected response format.');
      }
    } catch (err) {
      loadingEl.remove();
      appendAssistantMessage(`Unable to connect: ${err.message}`);
    } finally {
      isAwaitingResponse = false;
      sendBtn.disabled = !userInput.value.trim();
      userInput.focus();
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

  // ── 5. Message Rendering ──
  function appendUserMessage(text) {
    const group = document.createElement('div');
    group.className = 'message-group';
    group.innerHTML = `
      <div class="message-role">You</div>
      <div class="message-body"><p>${escapeHtml(text)}</p></div>
    `;
    conversationStream.appendChild(group);
    scrollToBottom();
  }

  function appendLoadingIndicator() {
    const group = document.createElement('div');
    group.className = 'message-group';
    group.innerHTML = `
      <div class="message-role">Assistant</div>
      <div class="message-body"><p style="color: #a1a1aa;">Thinking...</p></div>
    `;
    conversationStream.appendChild(group);
    scrollToBottom();
    return group;
  }

  function appendAssistantMessage(text) {
    const group = document.createElement('div');
    group.className = 'message-group';
    group.innerHTML = `
      <div class="message-role">Assistant</div>
      <div class="message-body">${formatMarkdown(text)}</div>
    `;
    conversationStream.appendChild(group);
    scrollToBottom();
  }

  async function handleActionResponse(action, isMock = false, generation = null) {
    const group = document.createElement('div');
    group.className = 'message-group';
    group.innerHTML = `
      <div class="message-role">Assistant</div>
      <div class="message-body">
        <p>Executing requested action:</p>
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
    conversationStream.appendChild(group);
    scrollToBottom();

    // Execute via active tab content script
    const statusEl = group.querySelector('#actionStatus');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        statusEl.className = 'action-status failed';
        statusEl.textContent = '● Failed: No active tab found.';
        return;
      }

      // Action carries generation to verify element identity against current page
      const actionPayload = {
        ...action,
        generation: generation || currentGeneration
      };

      chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action: actionPayload }, (res) => {
        if (chrome.runtime.lastError) {
          statusEl.className = 'action-status failed';
          statusEl.textContent = `● Failed: ${chrome.runtime.lastError.message}`;
        } else if (res && res.success) {
          statusEl.className = 'action-status success';
          statusEl.textContent = '● Executed safely in browser';
        } else {
          statusEl.className = 'action-status failed';
          statusEl.textContent = `● Failed: ${res?.error || 'Validation rejected action.'}`;
        }
      });
    } catch (e) {
      statusEl.className = 'action-status failed';
      statusEl.textContent = `● Error: ${e.message}`;
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
    // Format simple code blocks
    let html = escapeHtml(text);
    html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Split paragraphs
    const paragraphs = html.split(/\n\n+/);
    return paragraphs.map((p) => {
      const trimmed = p.trim();
      if (trimmed.startsWith('<pre>')) return trimmed;
      // Dash-separated list on single line
      if (trimmed.includes(' - ') && !trimmed.includes('\n')) {
        const parts = trimmed.split(/\s+-\s+/);
        const intro = parts[0];
        const items = parts.slice(1).map(item => `<li>${item.trim()}</li>`).join('');
        return (intro ? `<p>${intro}</p>` : '') + `<ul>${items}</ul>`;
      }
      // Multiline list items
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

  // ── 6. Header Close ──
  closeBtn.addEventListener('click', () => {
    window.close();
  });

  // ── 7. Screenshot Toggle ──
  function applyScreenshotNote(enabled) {
    if (!screenshotNoteEl) return;
    if (enabled) {
      screenshotNoteEl.textContent = 'Sanitized locally · faces blurred · PII masked';
    } else {
      screenshotNoteEl.textContent = 'Screenshot excluded from AI context';
    }
  }

  // Load initial toggle state
  chrome.storage.local.get([SCREENSHOT_KEY], (result) => {
    const enabled = result[SCREENSHOT_KEY] !== false; // default ON
    if (screenshotToggleEl) {
      screenshotToggleEl.checked = enabled;
      screenshotToggleEl.setAttribute('aria-checked', String(enabled));
    }
    applyScreenshotNote(enabled);
  });

  // Persist changes
  if (screenshotToggleEl) {
    screenshotToggleEl.addEventListener('change', () => {
      const enabled = screenshotToggleEl.checked;
      screenshotToggleEl.setAttribute('aria-checked', String(enabled));
      chrome.storage.local.set({ [SCREENSHOT_KEY]: enabled });
      applyScreenshotNote(enabled);
    });
  }

  // Init
  fetchLatestContext();
});
