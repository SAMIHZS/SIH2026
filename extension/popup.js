/**
 * Popup Script — SIH26171 Phase 1
 * 
 * Simple popup with:
 * - Privacy ON/OFF toggle
 * - Detection stats
 * - Open sidebar button
 */

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('privacyToggle');
  const statusText = document.getElementById('statusText');
  const detectionCount = document.getElementById('detectionCount');
  const privacyStatus = document.getElementById('privacyStatus');
  const openSidebarBtn = document.getElementById('openSidebar');
  
  // Load current state
  chrome.runtime.sendMessage({ type: 'GET_PRIVACY_STATE' }, (response) => {
    if (response) {
      toggle.checked = response.enabled;
      updateStatusDisplay(response.enabled);
    }
  });
  
  // Load latest context info
  chrome.runtime.sendMessage({ type: 'GET_LATEST_CONTEXT' }, (response) => {
    if (response && response.sanitizedContext) {
      detectionCount.textContent = response.detectionCount || 0;
      privacyStatus.textContent = 'Safe';
      privacyStatus.className = 'stat-value stat-safe';
    }
  });
  
  // Toggle handler
  toggle.addEventListener('change', () => {
    const enabled = toggle.checked;
    chrome.runtime.sendMessage({ type: 'SET_PRIVACY_STATE', enabled });
    updateStatusDisplay(enabled);
    
    // Also notify active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_PRIVACY', enabled }).catch(() => {});
      }
    });
  });
  
  // Open sidebar
  openSidebarBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.sidePanel.open({ tabId: tabs[0].id }).catch((err) => {
          console.warn('Could not open side panel:', err);
        });
      }
    });
  });
  
  function updateStatusDisplay(enabled) {
    if (enabled) {
      statusText.textContent = 'Active — detecting & sanitizing PII';
      statusText.className = 'status-text';
    } else {
      statusText.textContent = 'Disabled — no PII protection';
      statusText.className = 'status-text disabled';
    }
  }
});
