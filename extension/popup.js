/**
 * Minimal Browser Extension Popup
 */
document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusHeading = document.getElementById('statusHeading');
  const statusSub = document.getElementById('statusSub');
  const siteDomain = document.getElementById('siteDomain');
  const protectionSummary = document.getElementById('protectionSummary');
  const openSidebarBtn = document.getElementById('openSidebar');
  const openSettingsBtn = document.getElementById('openSettings');

  let privacyEnabled = true;

  // 1. Get current tab domain
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab && tab.url) {
      try {
        const parsed = new URL(tab.url);
        if (parsed.protocol.startsWith('http')) {
          siteDomain.textContent = parsed.hostname.replace(/^www\./, '');
        } else {
          siteDomain.textContent = 'Browser page';
        }
      } catch (_) {
        siteDomain.textContent = 'Current page';
      }
    } else {
      siteDomain.textContent = 'Current page';
    }
  });

  // 2. Query privacy enabled state
  chrome.runtime.sendMessage({ type: 'GET_PRIVACY_STATE' }, (response) => {
    if (response) {
      privacyEnabled = response.enabled !== false;
      applyState();
    }
  });

  // 3. Query latest context for detection count
  chrome.runtime.sendMessage({ type: 'GET_LATEST_CONTEXT' }, (response) => {
    if (response) {
      const count = response.detectionCount || 0;
      applyDetectionSummary(count);
    }
  });

  function applyState() {
    if (!privacyEnabled) {
      statusDot.classList.add('paused');
      statusHeading.textContent = 'Protection paused';
      statusSub.textContent = 'Protection is paused.';
      protectionSummary.textContent = 'Protection is disabled';
    } else {
      statusDot.classList.remove('paused');
      statusHeading.textContent = 'Protected';
      statusSub.textContent = 'This page is protected.';
    }
  }

  function applyDetectionSummary(count) {
    if (!privacyEnabled) {
      protectionSummary.textContent = 'Protection is disabled';
    } else if (count > 1) {
      protectionSummary.textContent = `${count} sensitive items protected locally`;
    } else if (count === 1) {
      protectionSummary.textContent = '1 sensitive item protected locally';
    } else {
      protectionSummary.textContent = 'Nothing sensitive detected';
    }
  }

  // 4. Action: Open Assistant Sidebar
  openSidebarBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (tabId) {
        chrome.sidePanel.open({ tabId }).catch((err) => {
          console.warn('[SIH26171] Could not open side panel:', err);
        });
      }
    });
  });

  // 5. Settings: Open Options Page
  openSettingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
