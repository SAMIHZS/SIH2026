/**
 * Sidebar Script — SIH26171 Phase 1
 *
 * Responsibilities:
 * 1. Manages Tab switching (Chat vs Privacy View)
 * 2. Receives and displays SanitizedContext updates from Background / Content script
 * 3. Handles user chat prompts and forwards them to background (`SEND_TO_BACKEND`)
 * 4. Displays assistant responses (text or action) with visible mock badges if fallback
 * 5. Sends validated actions to Content Script for execution (`EXECUTE_ACTION`)
 * 6. Renders the live Privacy Pipeline visualization (Raw -> Detected -> Sanitized -> Network Safe)
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const tabChat = document.getElementById('tabChat');
  const tabPrivacy = document.getElementById('tabPrivacy');
  const panelChat = document.getElementById('panelChat');
  const panelPrivacy = document.getElementById('panelPrivacy');
  const messageContainer = document.getElementById('messageContainer');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const contextStatus = document.getElementById('contextStatus');
  const contextIndicator = document.getElementById('contextIndicator');
  const privacyBadge = document.getElementById('privacyBadge');

  // Privacy View DOM Elements
  const detectionList = document.getElementById('detectionList');
  const sanitizedView = document.getElementById('sanitizedView');
  const networkView = document.getElementById('networkView');

  // Local State
  let currentContext = null;
  let currentMapping = null;
  let currentDetectionCount = 0;
  let isAwaitingResponse = false;

  // ── 1. Tab Navigation ──
  tabChat.addEventListener('click', () => switchTab('chat'));
  tabPrivacy.addEventListener('click', () => switchTab('privacy'));

  function switchTab(tab) {
    if (tab === 'chat') {
      tabChat.classList.add('active');
      tabPrivacy.classList.remove('active');
      panelChat.classList.add('active');
      panelPrivacy.classList.remove('active');
    } else {
      tabPrivacy.classList.add('active');
      tabChat.classList.remove('active');
      panelPrivacy.classList.add('active');
      panelChat.classList.remove('active');
      renderPrivacyView();
    }
  }

  // ── 2. Context Sync with Background ──
  function fetchLatestContext() {
    chrome.runtime.sendMessage({ type: 'GET_LATEST_CONTEXT' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (response.sanitizedContext) {
        updateContext(response.sanitizedContext, response.detectionCount, response.mapping);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'CONTEXT_UPDATE') {
      updateContext(message.sanitizedContext, message.detectionCount, message.mapping);
    }
  });

  function updateContext(context, detectionCount, mapping) {
    currentContext = context;
    currentDetectionCount = detectionCount || 0;
    currentMapping = mapping || null;

    if (contextIndicator) {
      const dot = contextIndicator.querySelector('.ctx-dot');
      if (dot) dot.classList.remove('analyzing');
    }

    const title = context.page?.title || 'Current Page';
    const elemCount = context.elements?.length || 0;
    contextStatus.textContent = `${title.substring(0, 24)} (${elemCount} elements, ${currentDetectionCount} PII protected)`;

    if (currentDetectionCount > 0) {
      privacyBadge.className = 'privacy-badge';
      privacyBadge.innerHTML = '<span class="badge-dot"></span><span class="badge-text">Protected</span>';
    } else {
      privacyBadge.className = 'privacy-badge';
      privacyBadge.innerHTML = '<span class="badge-dot"></span><span class="badge-text">Safe</span>';
    }

    // Refresh privacy view if open
    if (panelPrivacy.classList.contains('active')) {
      renderPrivacyView();
    }
  }

  // ── 3. Privacy Pipeline Visualizer ──
  function renderPrivacyView() {
    if (!currentContext) {
      detectionList.innerHTML = '<p class="empty-state">No page analyzed yet.</p>';
      sanitizedView.innerHTML = '<p class="empty-state">Waiting for page analysis...</p>';
      networkView.innerHTML = '<p class="empty-state">No network payload generated yet.</p>';
      return;
    }

    // A. Detected Sensitive Data
    if (currentMapping && Object.keys(currentMapping).length > 0) {
      let html = '';
      for (const [token, meta] of Object.entries(currentMapping)) {
        html += `
          <div class="detection-item">
            <div>
              <span class="detection-type">${escapeHtml(meta.type || 'PII')}</span>
              <span class="detection-label">${escapeHtml(meta.source || 'detector')}</span>
            </div>
            <span class="token">${escapeHtml(token)}</span>
          </div>
        `;
      }
      detectionList.innerHTML = html;
    } else if (currentDetectionCount > 0) {
      detectionList.innerHTML = `
        <div class="detection-item">
          <span class="detection-type">PROTECTED PII</span>
          <span class="token">${currentDetectionCount} items sanitized</span>
        </div>
      `;
    } else {
      detectionList.innerHTML = '<p class="empty-state">No sensitive PII detected on this page.</p>';
    }

    // B. Sanitized Representation
    const sanitizedText = currentContext.text || '';
    if (sanitizedText) {
      // Highlight sanitized tokens like [EMAIL_1], [PHONE_1], etc.
      const highlighted = escapeHtml(sanitizedText).replace(
        /(\[[A-Z0-9_]+(?:_[0-9]+)?\])/g,
        '<span class="token">$1</span>'
      );
      sanitizedView.innerHTML = highlighted;
    } else {
      sanitizedView.innerHTML = '<p class="empty-state">No text extracted.</p>';
    }

    // C. Network Context (Exact payload sent to remote AI)
    const payloadSample = {
      sanitized_context: {
        page: currentContext.page,
        elements_count: currentContext.elements?.length || 0,
        sample_elements: (currentContext.elements || []).slice(0, 5),
        text_preview: (currentContext.text || '').substring(0, 300) + '...'
      }
    };
    networkView.textContent = JSON.stringify(payloadSample, null, 2);
  }

  // ── 4. Chat & User Interaction ──
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  sendBtn.addEventListener('click', handleSend);

  async function handleSend() {
    const text = userInput.value.trim();
    if (!text || isAwaitingResponse) return;

    // Append user message
    appendMessage('user', text);
    userInput.value = '';
    userInput.style.height = 'auto';

    isAwaitingResponse = true;
    sendBtn.disabled = true;

    // Show loading assistant message
    const loadingMsgEl = appendLoadingMessage();

    try {
      const response = await sendToBackend(text);
      loadingMsgEl.remove();

      if (!response) {
        appendMessage('assistant', 'Error: No response from assistant service.');
        return;
      }

      if (response.error) {
        appendErrorMessage(response.error);
        return;
      }

      if (response.type === 'action' && response.action) {
        await handleActionResponse(response.action, response.isMock, response.mockReason);
      } else if (response.type === 'text' || response.message) {
        appendAssistantTextMessage(response.message || 'Understood.', response.isMock, response.mockReason);
      } else {
        appendMessage('assistant', 'Received unexpected response format.');
      }
    } catch (err) {
      loadingMsgEl.remove();
      appendErrorMessage(`Failed to reach assistant: ${err.message}`);
    } finally {
      isAwaitingResponse = false;
      sendBtn.disabled = false;
      userInput.focus();
    }
  }

  function sendToBackend(userMessage) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'SEND_TO_BACKEND',
          userMessage: userMessage,
          sanitizedContext: currentContext
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

  // ── 5. Action Execution Flow ──
  async function handleActionResponse(action, isMock, mockReason) {
    const actionEl = document.createElement('div');
    actionEl.className = 'message assistant';

    let mockHtml = '';
    if (isMock) {
      mockHtml = `<div class="message-mock">⚠️ Demo Resilience: ${escapeHtml(mockReason || 'Mock fallback')}</div>`;
    }

    actionEl.innerHTML = `
      <div class="message-avatar">🤖</div>
      <div class="message-content">
        <p>I would like to perform an action on the page:</p>
        <div class="message-action">
          <div class="action-type">ACTION: ${escapeHtml(action.action)}</div>
          <div class="action-detail">Target: <code>${escapeHtml(action.target || 'None')}</code></div>
          ${action.value ? `<div class="action-detail">Value: <code>${escapeHtml(action.value)}</code></div>` : ''}
          ${action.riskLevel ? `<div class="action-detail">Risk: ${escapeHtml(action.riskLevel)}</div>` : ''}
          <div class="action-result" id="actionStatus">Executing local validation & action...</div>
        </div>
        ${mockHtml}
      </div>
    `;
    messageContainer.appendChild(actionEl);
    scrollToBottom();

    // Query active tab to execute action via content script
    const statusEl = actionEl.querySelector('#actionStatus');
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || tabs.length === 0) {
        statusEl.className = 'action-result failed';
        statusEl.textContent = '❌ Execution failed: No active tab found.';
        return;
      }

      chrome.tabs.sendMessage(
        tabs[0].id,
        { type: 'EXECUTE_ACTION', action: action },
        (res) => {
          if (chrome.runtime.lastError) {
            statusEl.className = 'action-result failed';
            statusEl.textContent = `❌ Execution failed: ${chrome.runtime.lastError.message}`;
          } else if (res && res.success) {
            statusEl.className = 'action-result success';
            statusEl.textContent = '✅ Validated & Executed safely in browser.';
          } else {
            statusEl.className = 'action-result failed';
            statusEl.textContent = `❌ ${res?.error || 'Validation rejected action.'}`;
          }
        }
      );
    } catch (e) {
      statusEl.className = 'action-result failed';
      statusEl.textContent = `❌ Execution error: ${e.message}`;
    }
  }

  // ── 6. Message Rendering Helpers ──
  function appendMessage(role, text) {
    const msg = document.createElement('div');
    msg.className = `message ${role}`;
    msg.innerHTML = `
      <div class="message-avatar">${role === 'user' ? '👤' : '🤖'}</div>
      <div class="message-content">
        <p>${escapeHtml(text)}</p>
      </div>
    `;
    messageContainer.appendChild(msg);
    scrollToBottom();
  }

  function appendAssistantTextMessage(text, isMock, mockReason) {
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    let mockHtml = '';
    if (isMock) {
      mockHtml = `<div class="message-mock">⚠️ Demo Resilience: ${escapeHtml(mockReason || 'Mock fallback')}</div>`;
    }
    msg.innerHTML = `
      <div class="message-avatar">🤖</div>
      <div class="message-content">
        <p>${escapeHtml(text)}</p>
        ${mockHtml}
      </div>
    `;
    messageContainer.appendChild(msg);
    scrollToBottom();
  }

  function appendErrorMessage(text) {
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    msg.innerHTML = `
      <div class="message-avatar">⚠️</div>
      <div class="message-content">
        <div class="message-error">${escapeHtml(text)}</div>
      </div>
    `;
    messageContainer.appendChild(msg);
    scrollToBottom();
  }

  function appendLoadingMessage() {
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    msg.innerHTML = `
      <div class="message-avatar">🤖</div>
      <div class="message-content">
        <p class="message-hint">Thinking securely...</p>
      </div>
    `;
    messageContainer.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function scrollToBottom() {
    messageContainer.scrollTop = messageContainer.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initialize
  fetchLatestContext();
});
