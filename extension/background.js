/**
 * Service Worker (Background) — SIH26171 Phase 1
 * 
 * Responsibilities:
 * 1. Route extension messages (content ↔ sidebar ↔ popup)
 * 2. Capture screenshots via chrome.tabs.captureVisibleTab
 * 3. Send SanitizedContext to FastAPI backend
 * 4. Receive Action or text response
 * 5. Handle errors, timeouts, mock fallback
 * 
 * The service worker owns backend communication.
 * Content scripts do NOT make cross-origin requests.
 */

// ── Configuration ──
const BACKEND_URL = 'http://localhost:8000';
const BACKEND_TIMEOUT_MS = 30000;

// ── State ──
let latestContext = null;
let latestMapping = null;
let latestDetectionCount = 0;

// ── Message Routing ──

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CONTEXT_READY':
      // Content script has new sanitized context
      latestContext = message.sanitizedContext;
      latestMapping = message.mapping;
      latestDetectionCount = message.detectionCount;
      // Forward to sidebar if open
      broadcastToExtensionPages({
        type: 'CONTEXT_UPDATE',
        sanitizedContext: message.sanitizedContext,
        detectionCount: message.detectionCount,
        mapping: message.mapping
      });
      sendResponse({ ok: true });
      return false;
    
    case 'GET_LATEST_CONTEXT':
      // Sidebar or popup requesting current context
      sendResponse({
        sanitizedContext: latestContext,
        detectionCount: latestDetectionCount,
        mapping: latestMapping
      });
      return false;
    
    case 'SEND_TO_BACKEND':
      // Sidebar requests backend reasoning
      handleBackendRequest(message, sender).then(sendResponse);
      return true; // Async response
    
    case 'CAPTURE_SCREENSHOT':
      // Request screenshot capture + redaction
      handleScreenshotCapture(message, sender).then(sendResponse);
      return true; // Async response
    
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

// ── Side Panel Setup ──

// Open side panel when extension icon is clicked (if supported)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// ── Backend Communication ──

/**
 * Send SanitizedContext to backend and get response.
 * Falls back to deterministic mock on failure.
 */
async function handleBackendRequest(message, sender) {
  const sanitizedContext = message.sanitizedContext || latestContext;
  const userMessage = message.userMessage || '';
  
  if (!sanitizedContext) {
    return { 
      type: 'text', 
      message: 'No page context available yet. Please wait for the page to be analyzed.',
      isMock: false 
    };
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
    
    const response = await fetch(`${BACKEND_URL}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sanitized_context: sanitizedContext,
        user_message: userMessage
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Validate response structure
    if (data.type === 'action') {
      // Schema validate the action
      if (!data.action || !data.action.action) {
        throw new Error('Malformed action response from backend');
      }
      return { ...data, isMock: false };
    } else if (data.type === 'text') {
      return { ...data, isMock: false };
    } else {
      throw new Error('Unknown response type from backend');
    }
    
  } catch (err) {
    console.warn('[SIH26171] Backend request failed, using mock fallback:', err.message);
    return getDeterministicMockResponse(sanitizedContext, userMessage);
  }
}

/**
 * Deterministic mock response for demo resilience.
 * This is VISIBLY documented as a mock, not disguised as live AI.
 */
function getDeterministicMockResponse(sanitizedContext, userMessage) {
  const lowerMsg = (userMessage || '').toLowerCase();
  
  // Simple deterministic logic based on user message
  if (lowerMsg.includes('click') || lowerMsg.includes('press') || lowerMsg.includes('submit')) {
    // Try to find a button
    const button = sanitizedContext.elements?.find(e => 
      e.tag === 'button' || (e.tag === 'input' && e.role === 'button')
    );
    if (button) {
      return {
        type: 'action',
        action: {
          action: 'click',
          target: button.id ? `#${button.id}` : `button`,
          riskLevel: 'low'
        },
        isMock: true,
        mockReason: 'Backend unavailable — using deterministic fallback'
      };
    }
  }
  
  if (lowerMsg.includes('search') || lowerMsg.includes('type') || lowerMsg.includes('enter')) {
    const input = sanitizedContext.elements?.find(e => 
      e.tag === 'input' && !['submit', 'button', 'hidden'].includes(e.role)
    );
    if (input) {
      return {
        type: 'action',
        action: {
          action: 'type',
          target: input.id ? `#${input.id}` : 'input',
          value: 'test search',
          riskLevel: 'low'
        },
        isMock: true,
        mockReason: 'Backend unavailable — using deterministic fallback'
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
        riskLevel: 'low'
      },
      isMock: true,
      mockReason: 'Backend unavailable — using deterministic fallback'
    };
  }
  
  // Default: text response
  return {
    type: 'text',
    message: `[MOCK FALLBACK] I can see a page titled "${sanitizedContext.page?.title || 'Unknown'}". ` +
      `I detected ${sanitizedContext.elements?.length || 0} interactive elements. ` +
      `The page content has been sanitized for privacy. ` +
      `How can I help you with this page?`,
    isMock: true,
    mockReason: 'Backend unavailable — using deterministic fallback'
  };
}

// ── Screenshot Capture & Redaction ──

/**
 * Capture screenshot and apply redaction from content script rects.
 */
async function handleScreenshotCapture(message, sender) {
  try {
    const tabId = sender.tab?.id;
    if (!tabId) {
      return { error: 'No tab ID available' };
    }
    
    // 1. Capture visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    
    // 2. Get redaction rects from content script
    const rectsResponse = await chrome.tabs.sendMessage(tabId, { type: 'GET_RECTS' });
    const rects = rectsResponse?.rects || [];
    
    if (rects.length === 0) {
      // No PII regions to redact — screenshot is safe
      return { screenshot: dataUrl };
    }
    
    // 3. Redact using offscreen canvas (or return with rects for content script to redact)
    // In MV3, we send the data back to the content script for canvas redaction
    // since service workers can't use Canvas directly
    return {
      screenshot: dataUrl,
      rects: rects,
      needsRedaction: true
    };
    
  } catch (err) {
    console.error('[SIH26171] Screenshot capture failed:', err);
    return { error: err.message };
  }
}

// ── Utility ──

/**
 * Broadcast a message to all extension pages (sidebar, popup).
 */
function broadcastToExtensionPages(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No listeners — sidebar/popup not open
  });
}
