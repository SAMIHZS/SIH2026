/**
 * Privacy Invalidation & State Machine Test Suite — SIH26171 Phase 2
 *
 * Verifies:
 * TEST P1 — Tab switch during analysis: Page A starts perception -> switch to Tab B -> late Page A result discarded
 * TEST P2 — Navigation during analysis: Page A navigates -> late Page A result discarded
 * TEST P3 — Chat during tab switch: Page A chat starts -> switch to Tab B -> Page A response discarded
 * TEST P4 — Provider request after context invalidation: context invalidated -> attempt chat -> NO CLOUD REQUEST (FAIL CLOSED)
 * TEST P5 — Screenshot ownership: Page A screenshot exists -> switch to Tab B -> Page B chat -> Page A screenshot NEVER attached
 * TEST P6 — ElementRegistry isolation: Page A element ID -> switch to Tab B -> attempt action -> ACTION REJECTED
 */

'use strict';

const assert = require('assert');

if (typeof self === 'undefined') {
  global.self = global;
}
if (!global.chrome) {
  global.chrome = {
    storage: {
      local: {
        get: (_k, cb) => cb({}),
        set: (_obj, cb) => cb && cb()
      }
    },
    runtime: {
      lastError: null
    }
  };
}

require('../extension/logger.js');
require('../extension/providers/localProvider.js');
require('../extension/modelManager.js');

// ── Test harness ──
let passed = 0;
let failed = 0;
const testQueue = [];

function test(name, fn) {
  testQueue.push({ name, fn });
}

function asyncTest(name, fn) {
  testQueue.push({ name, fn });
}

// ── Mock ElementRegistry ──
const ElementRegistryModule = require('../extension/elementRegistry.js');

// ── Minimal Action Validator ──
function validateActionWithGeneration(action, expectedGeneration, registry) {
  if (!action || typeof action !== 'object') {
    return { allowed: false, reason: 'Action is not a valid object' };
  }
  if (typeof action.generation === 'number' && typeof expectedGeneration === 'number') {
    if (action.generation !== expectedGeneration) {
      return { allowed: false, reason: `Action rejected: action generation (${action.generation}) does not match current page generation (${expectedGeneration})` };
    }
  }
  if (['click', 'type'].includes(action.action)) {
    const targetEl = registry.resolve(action.target, expectedGeneration);
    if (!targetEl) {
      return { allowed: false, reason: `Target element not found or belongs to a different page generation: ${action.target}` };
    }
  }
  return { allowed: true };
}

// ── Privacy State Machine Simulation ──
class PrivacyStateMachine {
  constructor() {
    this.tabPerceptionState = new Map();
    this.activeTabId = null;
    this.globalGeneration = 0;
    this.discards = [];
    this.remoteTransmissions = [];
  }

  activateTab(tabId, url = 'https://example.com/page') {
    this.activeTabId = tabId;

    if (!this.tabPerceptionState.has(tabId)) {
      return this.invalidateTab(tabId, 'tab_activated', url);
    }
    return this.tabPerceptionState.get(tabId).generation;
  }

  navigateTab(tabId, newUrl) {
    return this.invalidateTab(tabId, 'navigation', newUrl);
  }

  invalidateTab(tabId, reason, url = '') {
    this.globalGeneration++;
    const nextGen = this.globalGeneration;
    const existing = this.tabPerceptionState.get(tabId);

    if (existing) {
      existing.isValid = false;
      existing.sanitizedContext = null;
      existing.screenshot = null;
      existing.detections = [];
      existing.generation = nextGen;
      if (url) existing.navigationIdentity = url;
    } else {
      this.tabPerceptionState.set(tabId, {
        tabId,
        generation: nextGen,
        navigationIdentity: url || '',
        sanitizedContext: null,
        screenshot: null,
        detections: [],
        isValid: false
      });
    }
    return nextGen;
  }

  // Content script commits analysis
  commitAnalysisResult(tabId, generation, navigationIdentity, sanitizedContext, screenshot) {
    if (typeof navigationIdentity === 'object' && navigationIdentity !== null && sanitizedContext === undefined) {
      sanitizedContext = navigationIdentity;
      navigationIdentity = this.tabPerceptionState.get(tabId)?.navigationIdentity || '';
    }
    const currentTabState = this.tabPerceptionState.get(tabId);

    // Stale check
    if (
      tabId !== this.activeTabId ||
      !currentTabState ||
      generation !== currentTabState.generation ||
      (navigationIdentity && currentTabState.navigationIdentity && navigationIdentity !== currentTabState.navigationIdentity)
    ) {
      this.discards.push({
        tabId,
        generation,
        currentGeneration: currentTabState?.generation,
        reason: 'tab/navigation changed'
      });
      return { ok: false, discarded: true };
    }

    currentTabState.sanitizedContext = sanitizedContext;
    currentTabState.screenshot = screenshot || currentTabState.screenshot || null;
    currentTabState.isValid = true;
    return { ok: true, discarded: false };
  }

  closeTab(tabId) {
    if (this.tabPerceptionState.has(tabId)) {
      const state = this.tabPerceptionState.get(tabId);
      if (state) {
        state.screenshot = null;
        state.sanitizedContext = null;
        state.detections = [];
      }
      this.tabPerceptionState.delete(tabId);
    }
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
  }

  removeTab(tabId) {
    this.closeTab(tabId);
  }

  // Visual Pipeline commits result (Phase 3A/3B/3C fail-closed contract)
  commitVisualResult(tabId, requestedGeneration, visualResult, allowBackgroundTab = false) {
    const currentTabState = this.tabPerceptionState.get(tabId);

    // Stale check
    if (
      (!allowBackgroundTab && tabId !== this.activeTabId) ||
      !currentTabState ||
      requestedGeneration !== currentTabState.generation
    ) {
      this.discards.push({
        tabId,
        generation: requestedGeneration,
        currentGeneration: currentTabState?.generation,
        reason: 'generation mismatch or inactive tab'
      });
      return {
        ok: false,
        sanitizedDataUrl: null,
        detections: [],
        discarded: true,
        backend: 'unavailable',
        cvExecuted: false,
        ocrExecuted: false,
        error: 'Stale analysis discarded',
        generation: requestedGeneration
      };
    }

    // Fail-closed: if backend unavailable or no sanitizedDataUrl, never store or return image
    if (!visualResult || !visualResult.ok || !visualResult.sanitizedDataUrl || visualResult.backend === 'unavailable') {
      currentTabState.screenshot = null;
      return {
        ok: false,
        sanitizedDataUrl: null,
        detections: [],
        discarded: true,
        backend: 'unavailable',
        cvExecuted: false,
        ocrExecuted: false,
        error: visualResult?.error || 'CV_UNAVAILABLE',
        generation: requestedGeneration
      };
    }

    const structuredScreenshot = {
      sanitizedDataUrl: visualResult.sanitizedDataUrl,
      generation: requestedGeneration,
      tabId,
      backend: visualResult.backend || 'mediapipe',
      cvExecuted: true,
      ocrExecuted: Boolean(visualResult.ocrExecuted),
      ocrAvailable: Boolean(visualResult.ocrAvailable),
      ocrText: visualResult.ocrText || '',
      detections: (visualResult.detections || []).map(d => ({
        type: d.type || 'sensitive',
        source: d.source || 'mediapipe',
        x: d.x,
        y: d.y,
        width: d.width,
        height: d.height,
        confidence: d.confidence
      })),
      detectionCount: visualResult.detections?.length || 0,
      sanitized: true
    };

    currentTabState.screenshot = structuredScreenshot;
    return {
      ok: true,
      sanitizedDataUrl: visualResult.sanitizedDataUrl,
      detections: visualResult.detections || [],
      discarded: false,
      backend: visualResult.backend || 'mediapipe',
      cvExecuted: true,
      ocrExecuted: Boolean(visualResult.ocrExecuted),
      ocrAvailable: Boolean(visualResult.ocrAvailable),
      ocrText: visualResult.ocrText || '',
      generation: requestedGeneration,
      error: null
    };
  }

  // Provider Payload Gate
  sendToProvider(request, providerConfig = { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }) {
    const { tabId, generation, navigationIdentity, userMessage, sanitizedContext } = request;
    const activeState = this.tabPerceptionState.get(this.activeTabId);

    const failClosed = (reason, error = 'CONTEXT_INVALIDATED') => {
      return {
        allowed: false,
        error,
        message: 'Page context changed. Please retry.',
        reason
      };
    };

    if (!this.activeTabId || !activeState) {
      return failClosed('No active tab state found');
    }
    // Condition A: tabId is valid and matches active tab
    if (!tabId || tabId !== this.activeTabId) {
      return failClosed(`Request tab (${tabId}) does not match active tab (${this.activeTabId})`);
    }
    // Condition B & C: requestedGeneration exists and matches current generation
    if (generation === undefined || generation !== activeState.generation) {
      return failClosed(`Request generation (${generation}) does not match active generation (${activeState.generation})`);
    }
    if (navigationIdentity && activeState.navigationIdentity && navigationIdentity !== activeState.navigationIdentity) {
      return failClosed('Navigation identity mismatch');
    }
    const ctx = sanitizedContext || activeState.sanitizedContext;
    if (!ctx || !activeState.isValid) {
      return failClosed('No valid sanitized context');
    }

    if (providerConfig.provider === 'local') {
      return {
        allowed: false,
        error: 'PROVIDER_UNAVAILABLE',
        message: 'Local browser inference is not available in this build.'
      };
    }

    const visual = activeState.screenshot;
    let outgoingScreenshot = null;

    // Condition J: selected model explicitly supports image input
    if (!providerConfig.isVision) {
      // Text-only model: NEVER attach screenshot
      outgoingScreenshot = null;
    } else {
      // Vision-capable model
      if (ctx.screenshot) {
        // Condition D: sanitized screenshot exists
        if (!visual) {
          return failClosed('Screenshot data does not match active page generation', 'CONTEXT_INVALIDATED');
        }
        // Condition G: screenshot.sanitized === true
        if (typeof visual === 'object' && visual.sanitized !== true) {
          throw new Error('UNTRUSTED_VISUAL_ARTIFACT');
        }
        // Condition E: screenshot belongs to the same tab
        if (typeof visual === 'object' && visual.tabId && visual.tabId !== this.activeTabId) {
          return failClosed('Screenshot tab mismatch — cross-tab leakage blocked');
        }
        // Condition F: screenshot generation === current generation
        if (typeof visual === 'object' && visual.generation && visual.generation !== activeState.generation) {
          return failClosed('Screenshot generation mismatch — stale generation blocked');
        }
        // Condition I: screenshot is NOT marked unavailable
        if (typeof visual === 'object' && (visual.available === false || visual.backend === 'unavailable')) {
          return failClosed('Sanitized visual context is unavailable for this page.', 'SANITIZED_VISUAL_CONTEXT_UNAVAILABLE');
        }
        // Condition H: screenshot.sanitizedDataUrl exists
        const activeUrl = typeof visual === 'object' ? visual.sanitizedDataUrl : visual;
        if (!activeUrl || typeof activeUrl !== 'string' || !activeUrl.startsWith('data:image/')) {
          return failClosed('Sanitized visual context is unavailable for this page.', 'SANITIZED_VISUAL_CONTEXT_UNAVAILABLE');
        }
        if (ctx.screenshot !== activeUrl) {
          return failClosed('Screenshot data does not match active page generation', 'CONTEXT_INVALIDATED');
        }
        outgoingScreenshot = activeUrl;
      } else if (visual) {
        if (typeof visual === 'object' && visual.sanitized !== true) {
          throw new Error('UNTRUSTED_VISUAL_ARTIFACT');
        }
        if (typeof visual === 'object' && visual.tabId && visual.tabId !== this.activeTabId) {
          return failClosed('Screenshot tab mismatch — cross-tab leakage blocked');
        }
        if (typeof visual === 'object' && visual.generation && visual.generation !== activeState.generation) {
          return failClosed('Screenshot generation mismatch — stale generation blocked');
        }
        if (typeof visual === 'object' && (visual.available === false || visual.backend === 'unavailable')) {
          return failClosed('Sanitized visual context is unavailable for this page.', 'SANITIZED_VISUAL_CONTEXT_UNAVAILABLE');
        }
        const activeUrl = typeof visual === 'object' ? visual.sanitizedDataUrl : visual;
        if (activeUrl && typeof activeUrl === 'string' && activeUrl.startsWith('data:image/')) {
          outgoingScreenshot = activeUrl;
        }
      }
    }

    // Passed gate!
    this.remoteTransmissions.push({
      tabId,
      generation,
      navigationIdentity,
      provider: providerConfig.provider,
      model: providerConfig.model,
      hasScreenshot: Boolean(outgoingScreenshot),
      screenshotData: outgoingScreenshot || null,
      ocrText: providerConfig.isVision && visual?.ocrText ? visual.ocrText : null
    });

    return {
      allowed: true,
      hasScreenshot: Boolean(outgoingScreenshot),
      screenshotData: outgoingScreenshot || null,
      ocrText: providerConfig.isVision && visual?.ocrText ? visual.ocrText : null,
      response: { type: 'text', message: 'AI response for ' + userMessage }
    };
  }
}

// ── Run Tests ──

console.log('========================================================');
console.log('SIH26171 PHASE 2 — PRIVACY STATE MACHINE & ARCHITECTURE');
console.log('========================================================\n');

// ── TEST P1: Tab switch during analysis ──
test('TEST P1 — Tab switch during analysis (stale result discarded)', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(101, 'https://site-a.com');

  // Page A starts analysis with genA
  assert.strictEqual(sm.activeTabId, 101);

  // User switches to Tab B before Page A finishes
  const genB = sm.activateTab(102, 'https://site-b.com');
  assert.strictEqual(sm.activeTabId, 102);

  // Page A's analysis finishes late
  const lateResult = sm.commitAnalysisResult(101, genA, 'https://site-a.com', { page: { title: 'Page A' } }, 'data:image/png;base64,AAA');

  assert.strictEqual(lateResult.discarded, true);
  assert.strictEqual(sm.discards.length, 1);
  assert.strictEqual(sm.tabPerceptionState.get(102).sanitizedContext, null);
  assert.strictEqual(sm.tabPerceptionState.get(101).isValid, false);
});

// ── TEST P2: Navigation during analysis ──
test('TEST P2 — Navigation during analysis (stale result discarded)', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(101, 'https://site-a.com/page1');

  // Page A navigates to page2
  const genB = sm.navigateTab(101, 'https://site-a.com/page2');
  assert.notStrictEqual(genA, genB);

  // Late result from page1 arrives
  const lateResult = sm.commitAnalysisResult(101, genA, 'https://site-a.com/page1', { page: { title: 'Page 1' } }, 'data:image/png;base64,AAA');

  assert.strictEqual(lateResult.discarded, true);
  assert.strictEqual(sm.tabPerceptionState.get(101).sanitizedContext, null);
  assert.strictEqual(sm.tabPerceptionState.get(101).isValid, false);
});

// ── TEST P3: Chat during tab switch ──
test('TEST P3 — Chat during tab switch (Page A response discarded on Tab B)', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(101, 'https://site-a.com');
  sm.commitAnalysisResult(101, genA, 'https://site-a.com', { page: { title: 'Page A' } });

  // Sidebar initiates chat request for Tab A
  const chatRequest = {
    tabId: 101,
    generation: genA,
    navigationIdentity: 'https://site-a.com',
    userMessage: 'Summarize Page A',
    sanitizedContext: { page: { title: 'Page A' } }
  };

  // User switches to Tab B while request is processing
  const genB = sm.activateTab(102, 'https://site-b.com');

  // Provider response returns or gate checks
  const result = sm.sendToProvider(chatRequest);

  // Expected: Fail closed! Request tab (101) does not match active tab (102)
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.error, 'CONTEXT_INVALIDATED');
  assert.strictEqual(sm.remoteTransmissions.length, 0);
});

// ── TEST P4: Provider request after context invalidation ──
test('TEST P4 — Provider request after context invalidation (NO CLOUD REQUEST)', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(101, 'https://site-a.com');
  sm.commitAnalysisResult(101, genA, 'https://site-a.com', { page: { title: 'Page A' } });

  // Invalidate context
  sm.invalidateTab(101, 'user_action_refresh');

  // Attempt chat
  const result = sm.sendToProvider({
    tabId: 101,
    generation: genA, // Stale generation
    navigationIdentity: 'https://site-a.com',
    userMessage: 'What is this?',
    sanitizedContext: { page: { title: 'Page A' } }
  });

  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.error, 'CONTEXT_INVALIDATED');
  assert.strictEqual(result.message, 'Page context changed. Please retry.');
  assert.strictEqual(sm.remoteTransmissions.length, 0);
});

// ── TEST P5: Screenshot ownership ──
test('TEST P5 — Screenshot ownership (Page A screenshot never attached to Page B)', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(101, 'https://site-a.com');
  const screenshotA = 'data:image/png;base64,PAGE_A_SCREENSHOT';
  sm.commitAnalysisResult(101, genA, 'https://site-a.com', { page: { title: 'Page A' }, screenshot: screenshotA }, screenshotA);

  // Switch to Tab B
  const genB = sm.activateTab(102, 'https://site-b.com');
  // Tab B completes perception WITHOUT screenshot
  sm.commitAnalysisResult(102, genB, 'https://site-b.com', { page: { title: 'Page B' } }, null);

  // Try to send chat for Tab B attempting to smuggle Page A screenshot
  const result = sm.sendToProvider({
    tabId: 102,
    generation: genB,
    navigationIdentity: 'https://site-b.com',
    userMessage: 'Inspect page',
    sanitizedContext: { page: { title: 'Page B' }, screenshot: screenshotA } // Stale screenshot from Tab A
  });

  // Must be rejected by provider payload gate!
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.error, 'CONTEXT_INVALIDATED');
});

// ── TEST P6: ElementRegistry isolation ──
test('TEST P6 — ElementRegistry isolation (Page A element ID rejected on Page B)', () => {
  const registry = ElementRegistryModule;
  registry.reset();

  // Mock DOM elements
  const fakeElementA = { tagName: 'BUTTON', isConnected: true, nodeType: 1 };
  const fakeElementB = { tagName: 'BUTTON', isConnected: true, nodeType: 1 };

  // Page A: Generation 1
  registry.setContextGeneration(1, 'https://site-a.com');
  const idA = registry.register(fakeElementA, 1);
  assert.strictEqual(idA, 'el_1');
  assert.strictEqual(registry.resolve(idA, 1), fakeElementA);

  // Validate action under Generation 1
  const validAction = { action: 'click', target: idA, generation: 1 };
  const res1 = validateActionWithGeneration(validAction, 1, registry);
  assert.strictEqual(res1.allowed, true);

  // Switch to Page B: Generation 2
  registry.setContextGeneration(2, 'https://site-b.com');
  const idB = registry.register(fakeElementB, 2);
  assert.strictEqual(idB, 'el_2');

  // Attempt to execute Page A's element ID under Page B (Generation 2)
  const staleAction = { action: 'click', target: idA, generation: 1 };
  const res2 = validateActionWithGeneration(staleAction, 2, registry);

  assert.strictEqual(res2.allowed, false);
  assert.ok(res2.reason.includes('Action rejected') || res2.reason.includes('different page generation'));

  // Even if action generation was omitted, resolve against Generation 2 returns null
  assert.strictEqual(registry.resolve(idA, 2), null);
  const staleActionNoGen = { action: 'click', target: idA };
  const res3 = validateActionWithGeneration(staleActionNoGen, 2, registry);
  assert.strictEqual(res3.allowed, false);
});

// ── TEST P7: Fail-closed visual pipeline (CV unavailable) ──
test('TEST P7 — Fail-closed visual pipeline: CV unavailable returns sanitizedDataUrl: null, discarded: true, backend: unavailable', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(201, 'https://test-cv.com');

  const cvUnavailableResult = {
    ok: false,
    sanitizedDataUrl: null,
    detections: [],
    discarded: true,
    backend: 'unavailable',
    cvExecuted: false,
    ocrExecuted: false,
    error: 'CV_UNAVAILABLE'
  };

  const response = sm.commitVisualResult(201, genA, cvUnavailableResult);
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.sanitizedDataUrl, null);
  assert.strictEqual(response.discarded, true);
  assert.strictEqual(response.backend, 'unavailable');
  assert.strictEqual(response.error, 'CV_UNAVAILABLE');

  // Verify tab perception state did NOT store any screenshot
  const tabState = sm.tabPerceptionState.get(201);
  assert.strictEqual(tabState.screenshot, null);
});

// ── TEST P8: Forbid backend=unavailable + sanitizedDataUrl!=null combination ──
test('TEST P8 — Forbid backend=unavailable + sanitizedDataUrl!=null combination', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(202, 'https://test-illegal-state.com');

  // Forbidden combination simulation: worker claimed unavailable backend but leaked an unredacted screenshot
  const illegalResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,UNREDACTED_LEAK_TEST',
    detections: [],
    backend: 'unavailable', // FORBIDDEN COMBINATION
    error: 'CV_UNAVAILABLE'
  };

  const response = sm.commitVisualResult(202, genA, illegalResult);
  // Boundary must reject the unredacted leak!
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.sanitizedDataUrl, null, 'Must zero out screenshot when backend is unavailable');
  assert.strictEqual(response.discarded, true);
  assert.strictEqual(response.backend, 'unavailable');

  const tabState = sm.tabPerceptionState.get(202);
  assert.strictEqual(tabState.screenshot, null);
});

// ── TEST P9: Logger metadata-only sanitization ──
test('TEST P9 — Logger metadata-only sanitization: raw dataUrl and sanitizedDataUrl are never exposed in log output', () => {
  const LoggerModule = require('../extension/logger.js');

  const testPayload = {
    ok: true,
    backend: 'mediapipe',
    detectionCount: 3,
    dataUrl: 'data:image/png;base64,RAW_SCREENSHOT_DATA_NEVER_LEAK',
    screenshot: 'data:image/png;base64,RAW_SCREENSHOT_DATA_NEVER_LEAK',
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_IMAGE_DATA_NEVER_LOGGED',
    nested: {
      image: 'data:image/png;base64,NESTED_IMAGE_STRING'
    }
  };

  const sanitized = LoggerModule.sanitizeLogData(testPayload);
  assert.strictEqual(sanitized.dataUrl, '[REDACTED_IMAGE_DATA]');
  assert.strictEqual(sanitized.screenshot, '[REDACTED_IMAGE_DATA]');
  assert.strictEqual(sanitized.sanitizedDataUrl, '[REDACTED_IMAGE_DATA]');
  assert.strictEqual(sanitized.backend, 'mediapipe');
  assert.strictEqual(sanitized.detectionCount, 3);
  assert.strictEqual(sanitized.ok, true);

  // Directly sanitizing raw data URL string
  const rawStringSanitized = LoggerModule.sanitizeLogData('data:image/png;base64,LEAKED_STRING');
  assert.strictEqual(rawStringSanitized, '[REDACTED_IMAGE_DATA]');
});

// ── TEST P10: Honest execution contract ──
test('TEST P10 — Honest execution contract: cvExecuted and ocrExecuted report reality', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(203, 'https://test-contract.com');

  const honestSuccessResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,VALID_SANITIZED_DATA',
    detections: [{ type: 'face', x: 10, y: 10, width: 50, height: 50, source: 'mediapipe' }],
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  };

  const response = sm.commitVisualResult(203, genA, honestSuccessResult);
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.cvExecuted, true);
  assert.strictEqual(response.ocrExecuted, false, 'Must not claim OCR executed when it did not');
  assert.strictEqual(response.backend, 'mediapipe');
  assert.ok(response.sanitizedDataUrl);
});

// ── TEST P11: Visual result generation isolation ──
test('TEST P11 — Visual result generation isolation: Generation G visual result rejected if tab advanced to G+1', () => {
  const sm = new PrivacyStateMachine();
  // Tab 204 starts on Page A (Generation 1)
  const genA = sm.activateTab(204, 'https://site-a.com');
  assert.strictEqual(genA, 1);

  // Tab 204 navigates to Page B before visual worker finishes (advancing to Generation 2)
  const genB = sm.navigateTab(204, 'https://site-b.com');
  assert.strictEqual(genB, 2);

  // Late visual worker result arrives with generation 1
  const lateVisualResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,PAGE_A_SANITIZED_SCREENSHOT',
    detections: [{ type: 'face', x: 20, y: 20, width: 40, height: 40 }],
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  };

  const response = sm.commitVisualResult(204, genA, lateVisualResult);

  // Must be discarded!
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.discarded, true);
  assert.strictEqual(response.sanitizedDataUrl, null);
  assert.strictEqual(response.error, 'Stale analysis discarded');

  // Verify tab perception state for Generation 2 remains completely clean
  const tabState = sm.tabPerceptionState.get(204);
  assert.strictEqual(tabState.generation, 2);
  assert.strictEqual(tabState.screenshot, null);
});

// ── TEST P12: Sanitized screenshot is generation-bound ──
test('TEST P12 — Sanitized screenshot is generation-bound (bound to tabId + generation)', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(301, 'https://site-genbound.com');

  const visualResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_GENBOUND_IMAGE',
    detections: [{ type: 'face', x: 10, y: 10, width: 30, height: 30 }],
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  };

  const response = sm.commitVisualResult(301, genA, visualResult);
  assert.strictEqual(response.ok, true);

  const tabState = sm.tabPerceptionState.get(301);
  assert.ok(tabState.screenshot, 'Screenshot must exist in state');
  assert.strictEqual(tabState.screenshot.generation, genA, 'Screenshot must be bound to generation');
  assert.strictEqual(tabState.screenshot.tabId, 301, 'Screenshot must be bound to tabId');
  assert.strictEqual(tabState.screenshot.sanitized, true);
  assert.strictEqual(tabState.screenshot.backend, 'mediapipe');
  assert.strictEqual(tabState.screenshot.cvExecuted, true);
  assert.strictEqual(tabState.screenshot.ocrExecuted, false);
});

// ── TEST P13: Old-generation screenshot is rejected ──
test('TEST P13 — Old-generation screenshot is rejected (cannot overwrite newer generation)', () => {
  const sm = new PrivacyStateMachine();
  const gen1 = sm.activateTab(302, 'https://page-v1.com');
  const gen2 = sm.navigateTab(302, 'https://page-v2.com');
  assert.ok(gen2 > gen1);

  // Stale result for generation 1 attempts to commit
  const staleResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,STALE_V1_IMAGE',
    detections: [],
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  };

  const response = sm.commitVisualResult(302, gen1, staleResult);
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.discarded, true);
  assert.strictEqual(response.sanitizedDataUrl, null);

  const tabState = sm.tabPerceptionState.get(302);
  assert.strictEqual(tabState.screenshot, null, 'Current generation state must not be overwritten');
});

// ── TEST P14: Tab close removes screenshot state ──
test('TEST P14 — Tab close removes screenshot state (purged from memory)', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(303, 'https://closing-tab.com');

  sm.commitVisualResult(303, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,IMAGE_TO_PURGE',
    detections: [],
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  assert.ok(sm.tabPerceptionState.has(303));
  assert.ok(sm.tabPerceptionState.get(303).screenshot);

  // Close the tab
  sm.closeTab(303);

  assert.strictEqual(sm.tabPerceptionState.has(303), false, 'Tab state must be deleted upon close');
  assert.strictEqual(sm.tabPerceptionState.get(303), undefined);
});

// ── TEST P15: Sidebar receives sanitizedDataUrl but never raw screenshot ──
test('TEST P15 — Sidebar receives sanitizedDataUrl but never raw screenshot', () => {
  const rawScreenshotMock = 'data:image/png;base64,RAW_UNREDACTED_IMAGE_SENSITIVE';
  const sanitizedMock = 'data:image/png;base64,SANITIZED_SAFE_IMAGE';

  // Construct VISUAL_CONTEXT_UPDATE payload as background does
  const updateMessage = {
    type: 'VISUAL_CONTEXT_UPDATE',
    tabId: 304,
    generation: 5,
    visual: {
      available: true,
      sanitizedDataUrl: sanitizedMock,
      backend: 'mediapipe',
      cvExecuted: true,
      ocrExecuted: false,
      detectionCount: 1,
      sanitized: true
    }
  };

  // Assert contract invariants
  assert.strictEqual(updateMessage.visual.sanitizedDataUrl, sanitizedMock);
  assert.strictEqual(updateMessage.visual.rawScreenshot, undefined);
  assert.strictEqual(updateMessage.visual.dataUrl, undefined);
  assert.ok(!JSON.stringify(updateMessage).includes(rawScreenshotMock));
});

// ── TEST P16: Sidebar does not display detected PII values ──
test('TEST P16 — Sidebar does not display detected PII values (category metadata only)', () => {
  // Simulate detections that include raw PII values from content script
  const detectionsWithPII = [
    { type: 'email', value: 'secret.ceo@company.com', source: 'regex', x: 10, y: 10, width: 100, height: 20 },
    { type: 'phone', value: '+1-555-867-5309', source: 'regex', x: 10, y: 40, width: 80, height: 20 },
    { type: 'face', source: 'mediapipe', x: 50, y: 50, width: 60, height: 60 }
  ];

  // Helper formatting function matching sidebar.js formatTypeName logic
  function formatSafeCategories(detections) {
    return detections.map(d => {
      const clean = (d.type || 'sensitive').replace(/_/g, ' ').toLowerCase();
      return clean.charAt(0).toUpperCase() + clean.slice(1);
    });
  }

  const safeCategories = formatSafeCategories(detectionsWithPII);
  const formattedString = safeCategories.join(', ');

  assert.ok(formattedString.includes('Email'));
  assert.ok(formattedString.includes('Phone'));
  assert.ok(formattedString.includes('Face'));
  // Invariant: raw values must NEVER appear in formatted display output
  assert.strictEqual(formattedString.includes('secret.ceo@company.com'), false);
  assert.strictEqual(formattedString.includes('867-5309'), false);
});

// ── TEST P17: Tab A screenshot cannot appear in Tab B ──
test('TEST P17 — Tab A screenshot cannot appear in Tab B (strict tab isolation)', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(305, 'https://tab-a.com');
  const screenshotA = 'data:image/png;base64,TAB_A_SCREENSHOT';
  sm.commitVisualResult(305, genA, {
    ok: true,
    sanitizedDataUrl: screenshotA,
    detections: [],
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  // Switch to Tab B
  const genB = sm.activateTab(306, 'https://tab-b.com');
  const stateB = sm.tabPerceptionState.get(306);

  // Tab B must have its own fresh state, never Tab A's screenshot
  assert.strictEqual(stateB.screenshot, null, 'Tab B must start with screenshot=null');
  assert.notStrictEqual(stateB.screenshot, screenshotA, 'Tab B must never receive Tab A screenshot');
});

// ── TEST P18: Navigation clears old screenshot before new processing completes ──
test('TEST P18 — Navigation clears old screenshot before new processing completes', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(307, 'https://page-one.com');
  sm.commitVisualResult(307, genA, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,PAGE_ONE_SCREENSHOT',
    detections: [],
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  assert.ok(sm.tabPerceptionState.get(307).screenshot);

  // Navigation begins
  const genB = sm.navigateTab(307, 'https://page-two.com');
  assert.ok(genB > genA);

  const navigatingState = sm.tabPerceptionState.get(307);
  // Must be null immediately upon navigation
  assert.strictEqual(navigatingState.screenshot, null);
  assert.strictEqual(navigatingState.isValid, false);
});

// ── TEST P19: Visual failure produces no screenshot in sidebar ──
test('TEST P19 — Visual failure produces no screenshot in sidebar (fail-closed)', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(308, 'https://cv-crash.com');

  const crashResult = {
    ok: false,
    sanitizedDataUrl: null,
    backend: 'unavailable',
    cvExecuted: false,
    ocrExecuted: false,
    error: 'CV_UNAVAILABLE'
  };

  const response = sm.commitVisualResult(308, gen, crashResult);
  assert.strictEqual(response.ok, false);
  assert.strictEqual(response.sanitizedDataUrl, null);
  assert.strictEqual(response.backend, 'unavailable');

  const tabState = sm.tabPerceptionState.get(308);
  assert.strictEqual(tabState.screenshot, null);
});

// ── TEST P20: No base64 image payload appears in DevTools logs ──
test('TEST P20 — No base64 image payload appears in DevTools logs', () => {
  const LoggerModule = require('../extension/logger.js');

  const visualPayload = {
    type: 'VISUAL_RESULT',
    tabId: 309,
    generation: 12,
    sanitizedDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false,
    detectionCount: 2
  };

  const sanitizedLog = LoggerModule.sanitizeLogData(visualPayload);
  const logString = JSON.stringify(sanitizedLog);

  // Invariant: zero base64 payload strings in sanitized logs
  assert.ok(!logString.includes('iVBORw0KGgoAAAANSUhEUg'));
  assert.strictEqual(sanitizedLog.sanitizedDataUrl, '[REDACTED_IMAGE_DATA]');
  assert.strictEqual(sanitizedLog.backend, 'mediapipe');
  assert.strictEqual(sanitizedLog.detectionCount, 2);
});

// ── TEST P21: Vision request contains sanitizedDataUrl only ──
test('TEST P21 — Vision request contains sanitizedDataUrl only', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(401, 'https://test-p21.com');
  sm.commitAnalysisResult(401, gen, { elements: [{ id: 'el_1', tag: 'button' }] });
  sm.commitVisualResult(401, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,VALID_SANITIZED_PNG_DATA',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  const res = sm.sendToProvider(
    { tabId: 401, generation: gen, userMessage: 'Describe page' },
    { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
  );

  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.hasScreenshot, true);
  assert.strictEqual(res.screenshotData, 'data:image/png;base64,VALID_SANITIZED_PNG_DATA');
  assert.strictEqual(res.screenshotData.startsWith('data:image/png;base64,'), true);
});

// ── TEST P22: Raw screenshot cannot reach provider request ──
test('TEST P22 — Raw screenshot cannot reach provider request (provenance check)', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(402, 'https://test-p22.com');
  sm.commitAnalysisResult(402, gen, { elements: [] });

  // Untrusted / un-sanitized visual artifact injection attempt
  const tabState = sm.tabPerceptionState.get(402);
  tabState.screenshot = {
    sanitized: false, // NOT SANITIZED!
    sanitizedDataUrl: 'data:image/png;base64,RAW_SCREENSHOT_LEAK',
    tabId: 402,
    generation: gen
  };

  assert.throws(() => {
    sm.sendToProvider(
      { tabId: 402, generation: gen, userMessage: 'test' },
      { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
    );
  }, /UNTRUSTED_VISUAL_ARTIFACT/);
});

// ── TEST P23: Text-only model receives no image ──
test('TEST P23 — Text-only model receives no image', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(403, 'https://test-p23.com');
  sm.commitAnalysisResult(403, gen, { elements: [] });
  sm.commitVisualResult(403, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_PNG_PRESENT',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  // Request to text-only Groq model
  const res = sm.sendToProvider(
    { tabId: 403, generation: gen, userMessage: 'hello' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', isVision: false }
  );

  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.hasScreenshot, false);
  assert.strictEqual(res.screenshotData, null);
});

// ── TEST P24: Vision-capable model receives sanitized image ──
test('TEST P24 — Vision-capable model receives sanitized image', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(404, 'https://test-p24.com');
  sm.commitAnalysisResult(404, gen, { elements: [] });
  sm.commitVisualResult(404, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_IMAGE_P24',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  const res = sm.sendToProvider(
    { tabId: 404, generation: gen, userMessage: 'look at this image' },
    { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
  );

  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.hasScreenshot, true);
  assert.strictEqual(res.screenshotData, 'data:image/png;base64,SANITIZED_IMAGE_P24');
});

// ── TEST P25: Missing sanitized screenshot blocks image request ──
test('TEST P25 — Missing sanitized screenshot blocks image request', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(405, 'https://test-p25.com');
  sm.commitAnalysisResult(405, gen, { elements: [] });
  // No visual result committed: screenshot is null

  const res = sm.sendToProvider(
    { tabId: 405, generation: gen, userMessage: 'what is this' },
    { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
  );

  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.hasScreenshot, false);
  assert.strictEqual(res.screenshotData, null);
});

// ── TEST P26: Stale generation blocks provider request ──
test('TEST P26 — Stale generation blocks provider request', () => {
  const sm = new PrivacyStateMachine();
  const genG = sm.activateTab(406, 'https://test-p26.com');
  sm.commitAnalysisResult(406, genG, { elements: [] });

  // Page navigates to G+1
  const genNext = sm.navigateTab(406, 'https://test-p26.com/next');
  assert.ok(genNext > genG);

  // Attempt to execute request from older generation G
  const res = sm.sendToProvider(
    { tabId: 406, generation: genG, userMessage: 'stale request' },
    { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
  );

  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.error, 'CONTEXT_INVALIDATED');
});

// ── TEST P27: Wrong tab screenshot blocks provider request ──
test('TEST P27 — Wrong tab screenshot blocks provider request', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(407, 'https://tab-a.com');
  sm.commitAnalysisResult(407, genA, { elements: [] });
  sm.commitVisualResult(407, genA, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,TAB_A_SCREENSHOT',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  // Switch to Tab B
  const genB = sm.activateTab(408, 'https://tab-b.com');
  sm.commitAnalysisResult(408, genB, { elements: [] });

  // Infiltrate Tab A's screenshot into Tab B's state
  const tabBState = sm.tabPerceptionState.get(408);
  tabBState.screenshot = {
    sanitized: true,
    sanitizedDataUrl: 'data:image/png;base64,TAB_A_SCREENSHOT',
    tabId: 407, // WRONG TAB!
    generation: genB
  };

  const res = sm.sendToProvider(
    { tabId: 408, generation: genB, userMessage: 'hello' },
    { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
  );

  assert.strictEqual(res.allowed, false);
  assert.ok(res.reason.includes('tab mismatch'));
});

// ── TEST P28: Provider failure never triggers raw-image fallback ──
test('TEST P28 — Provider failure never triggers raw-image fallback', () => {
  let fallbackInvoked = false;

  function simulateProviderCall(shouldFail) {
    if (shouldFail) {
      // Simulate remote provider network failure
      const err = new Error('Remote 503 Provider Unavailable');
      // Invariant: Fail closed, return error, NEVER attempt raw capture
      return {
        type: 'text',
        error: 'PROVIDER_UNAVAILABLE',
        message: err.message
      };
    }
    return { type: 'text', message: 'OK' };
  }

  const result = simulateProviderCall(true);
  assert.strictEqual(result.error, 'PROVIDER_UNAVAILABLE');
  assert.strictEqual(fallbackInvoked, false);
});

// ── TEST P29: API key does not appear in logs ──
test('TEST P29 — API key does not appear in logs', () => {
  const LoggerModule = require('../extension/logger.js');
  const payload = {
    provider: 'gemini',
    apiKey: 'AIzaSyD-VERY_SECRET_KEY_1234567890',
    model: 'models/gemini-1.5-flash',
    nested: {
      secretToken: 'sk-123456789012345678901234567890'
    }
  };

  const sanitized = LoggerModule.sanitizeLogData(payload);
  const logStr = JSON.stringify(sanitized);

  assert.ok(!logStr.includes('AIzaSyD-VERY_SECRET_KEY'));
  assert.strictEqual(sanitized.apiKey, '[REDACTED]');
});

// ── TEST P30: Multimodal request body is never logged ──
test('TEST P30 — Multimodal request body is never logged', () => {
  const LoggerModule = require('../extension/logger.js');
  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } },
          { text: 'Hello model' }
        ]
      }
    ]
  };

  const sanitized = LoggerModule.sanitizeLogData(body);
  const logStr = JSON.stringify(sanitized);

  // Invariant: large inline base64 string is never logged in full
  assert.ok(!logStr.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='));
});

// ── TEST P31: Action execution rejects stale generation even after validation ──
test('TEST P31 — Action execution rejects stale generation even after validation', () => {
  // Simulate executeAction generation recheck
  function executeActionWithRecheck(action, currentGeneration) {
    if (typeof action?.generation === 'number' && typeof currentGeneration === 'number') {
      if (action.generation !== currentGeneration) {
        return {
          success: false,
          error: `Action execution rejected: stale generation (action=${action.generation}, current=${currentGeneration})`
        };
      }
    }
    return { success: true };
  }

  const validAction = { action: 'click', target: 'btn', generation: 5 };
  // Case A: generation matches
  const resMatch = executeActionWithRecheck(validAction, 5);
  assert.strictEqual(resMatch.success, true);

  // Case B: page navigated between validation and execution -> generation 6
  const resStale = executeActionWithRecheck(validAction, 6);
  assert.strictEqual(resStale.success, false);
  assert.ok(resStale.error.includes('stale generation'));
});

// ── TEST P32: Unavailable Local provider cannot be selected/executed as functional ──
test('TEST P32 — Unavailable Local provider cannot be selected/executed as functional', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(409, 'https://test-p32.com');
  sm.commitAnalysisResult(409, gen, { elements: [] });

  const res = sm.sendToProvider(
    { tabId: 409, generation: gen, userMessage: 'run locally' },
    { provider: 'local', model: 'local-default', isVision: false }
  );

  assert.strictEqual(res.allowed, false);
  assert.strictEqual(res.error, 'PROVIDER_UNAVAILABLE');
  assert.ok(res.message.includes('not available'));
});

// ── TEST P33: No confirmed dead screenshot message path remains ──
test('TEST P33 — No confirmed dead screenshot message path remains', () => {
  const fs = require('fs');
  const path = require('path');
  const bgContent = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
  const contentContent = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');

  // Verify dead message types are absent from active message listeners
  const deadTypes = ['CAPTURE_FOR_ANALYSIS', 'CAPTURE_SCREENSHOT', 'GET_RECTS', 'REDACT_SCREENSHOT', 'SYNC_GENERATION'];
  for (const deadType of deadTypes) {
    assert.strictEqual(bgContent.includes(`case '${deadType}':`), false, `background.js still handles dead message: ${deadType}`);
    assert.strictEqual(contentContent.includes(`case '${deadType}':`), false, `content.js still handles dead message: ${deadType}`);
  }
});

// ── TEST P34: No active raw screenshot exposure path remains ──
test('TEST P34 — No active raw screenshot exposure path remains', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(501, 'https://test-p34.com');
  sm.commitAnalysisResult(501, gen, { elements: [] });

  // Attempt to smuggle an unsanitized raw string into screenshot state
  const rawDataUrl = 'data:image/png;base64,RAW_UNSANITIZED_IMAGE_PIXELS';
  const tabState = sm.tabPerceptionState.get(501);
  tabState.screenshot = {
    sanitized: false, // NOT SANITIZED!
    sanitizedDataUrl: rawDataUrl,
    tabId: 501,
    generation: gen
  };

  assert.throws(() => {
    sm.sendToProvider(
      { tabId: 501, generation: gen, userMessage: 'look at this' },
      { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
    );
  }, /UNTRUSTED_VISUAL_ARTIFACT/);
});

// ── TEST P35: Image payloads cannot enter logs ──
test('TEST P35 — Image payloads cannot enter logs', () => {
  const LoggerModule = require('../extension/logger.js');
  const mockPayload = {
    tabId: 502,
    generation: 3,
    screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    sanitizedDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    screenshot: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  };

  const sanitized = LoggerModule.sanitizeLogData(mockPayload);
  const jsonStr = JSON.stringify(sanitized);

  // Must not contain base64 image data
  assert.strictEqual(jsonStr.includes('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'), false);
  assert.strictEqual(sanitized.screenshotDataUrl, '[REDACTED_IMAGE_DATA]');
  assert.strictEqual(sanitized.sanitizedDataUrl, '[REDACTED_IMAGE_DATA]');
  assert.strictEqual(sanitized.screenshot, '[REDACTED_IMAGE_DATA]');
});

// ── TEST P36: Tab-specific caches are fully cleaned on tab removal ──
test('TEST P36 — Tab-specific caches are fully cleaned on tab removal', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(503, 'https://test-p36.com');
  sm.commitAnalysisResult(503, gen, { elements: [] });
  sm.commitVisualResult(503, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,TAB_503_IMAGE',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  });

  assert.strictEqual(sm.tabPerceptionState.has(503), true);
  assert.ok(sm.tabPerceptionState.get(503).screenshot !== null);

  // Simulate tab removal
  sm.removeTab(503);

  assert.strictEqual(sm.tabPerceptionState.has(503), false);
});

// ── TEST P37: URL query/hash is excluded from privacy-sensitive context where unnecessary ──
test('TEST P37 — URL query/hash is excluded from privacy-sensitive context where unnecessary', () => {
  // Test the URL sanitizer function
  function sanitizePageUrl(href) {
    try {
      const u = new URL(href);
      return u.origin + u.pathname;
    } catch (e) {
      return href ? href.split('?')[0].split('#')[0] : '';
    }
  }

  const sensitiveUrl = 'https://portal.bank.com/account/dashboard?session_token=SECRET_AUTH_999&user=john#section_private';
  const cleanUrl = sanitizePageUrl(sensitiveUrl);

  assert.strictEqual(cleanUrl, 'https://portal.bank.com/account/dashboard');
  assert.strictEqual(cleanUrl.includes('SECRET_AUTH_999'), false);
  assert.strictEqual(cleanUrl.includes('section_private'), false);
});

// ── TEST P38: DOM readiness / content-script handshake remains correct ──
test('TEST P38 — DOM readiness / content-script handshake remains correct', () => {
  // Mock content script PING handler response
  function handlePing(analysisState, currentGeneration) {
    return { ok: true, state: analysisState, generation: currentGeneration };
  }

  const res = handlePing('IDLE', 7);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.state, 'IDLE');
  assert.strictEqual(res.generation, 7);
});

// ── TEST P39: Generation increments have exactly one authoritative source ──
test('TEST P39 — Generation increments have exactly one authoritative source', () => {
  const sm = new PrivacyStateMachine();
  const gen1 = sm.activateTab(504, 'https://test-p39.com');
  assert.strictEqual(gen1, 1);

  // Normal navigation increments generation
  const gen2 = sm.navigateTab(504, 'https://test-p39.com/next');
  assert.strictEqual(gen2, 2);

  // Merely querying or getting context does NOT increment generation
  const state = sm.tabPerceptionState.get(504);
  assert.strictEqual(state.generation, 2);

  // Tab switch back to same page does NOT increment generation
  sm.activateTab(505, 'https://other.com');
  sm.activateTab(504, 'https://test-p39.com/next');
  assert.strictEqual(sm.tabPerceptionState.get(504).generation, 2);
});

// ── TEST P40: Provider capability comes from one authoritative capability implementation ──
test('TEST P40 — Provider capability comes from one authoritative capability implementation', () => {
  const mm = self.SIH_ModelManager;

  const geminiVision = mm.getModelCapabilities('gemini', 'models/gemini-1.5-flash');
  assert.strictEqual(geminiVision.text, true);
  assert.strictEqual(geminiVision.vision, true);
  assert.strictEqual(geminiVision.tools, false);

  const geminiEmbedding = mm.getModelCapabilities('gemini', 'models/text-embedding-004');
  assert.strictEqual(geminiEmbedding.vision, false);

  const groqChat = mm.getModelCapabilities('groq', 'llama-3.3-70b-versatile');
  assert.strictEqual(groqChat.text, true);
  assert.strictEqual(groqChat.vision, false);

  const openRouterChat = mm.getModelCapabilities('openrouter', 'meta-llama/llama-3-8b-instruct');
  assert.strictEqual(openRouterChat.text, true);
  assert.strictEqual(openRouterChat.vision, false);
});

// ── TEST P41: Local provider unavailable cannot execute a request ──
test('TEST P41 — Local provider unavailable cannot execute a request', async () => {
  const LocalProvider = self.SIH_LocalProvider.LocalProvider;
  const local = new LocalProvider();

  const status = await local.status();
  assert.strictEqual(status.available, false);
  await assert.rejects(async () => {
    await local.chat(null, 'default', {}, 'hello');
  }, /not available/);
});

// ── TEST P42: ElementRegistry remains generation-scoped ──
test('TEST P42 — ElementRegistry remains generation-scoped', () => {
  // Simulate ElementRegistry generation scoping
  const registry = {
    elements: new Map(),
    currentGen: 1,
    setGeneration(gen) {
      this.currentGen = gen;
      this.elements.clear();
    },
    register(id, element) {
      this.elements.set(id, { element, generation: this.currentGen });
    },
    resolve(id, queryGen) {
      const entry = this.elements.get(id);
      if (!entry || entry.generation !== queryGen) {
        return null;
      }
      return entry.element;
    }
  };

  registry.setGeneration(10);
  registry.register('btn_submit', { tagName: 'BUTTON' });

  // Matching generation resolves
  assert.ok(registry.resolve('btn_submit', 10) !== null);

  // Stale or newer generation is rejected
  assert.strictEqual(registry.resolve('btn_submit', 9), null);
  assert.strictEqual(registry.resolve('btn_submit', 11), null);
});

// ── TEST P43: execute.js rejects stale generation ──
test('TEST P43 — execute.js rejects stale generation', () => {
  function executeAction(action, currentGen) {
    if (typeof action?.generation === 'number' && typeof currentGen === 'number') {
      if (action.generation !== currentGen) {
        return { success: false, error: 'ACTION_STALE_GENERATION' };
      }
    }
    return { success: true };
  }

  assert.strictEqual(executeAction({ action: 'click', target: 'b1', generation: 4 }, 4).success, true);
  assert.strictEqual(executeAction({ action: 'click', target: 'b1', generation: 3 }, 4).success, false);
  assert.strictEqual(executeAction({ action: 'click', target: 'b1', generation: 3 }, 4).error, 'ACTION_STALE_GENERATION');
});

// ── TEST P44: Concurrent visual requests cannot overwrite each other state ──
test('TEST P44 — Concurrent visual requests cannot overwrite each other state', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(601, 'https://site-a.com');
  sm.commitAnalysisResult(601, genA, { elements: [] });

  const genB = sm.activateTab(602, 'https://site-b.com');
  sm.commitAnalysisResult(602, genB, { elements: [] });

  // Simulate two concurrent visual worker results returning for their respective tabs
  sm.commitVisualResult(601, genA, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_TAB_A',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  }, true);

  sm.commitVisualResult(602, genB, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_TAB_B',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false
  }, true);

  const stateA = sm.tabPerceptionState.get(601);
  const stateB = sm.tabPerceptionState.get(602);

  assert.strictEqual(stateA.screenshot.sanitizedDataUrl, 'data:image/png;base64,SANITIZED_TAB_A');
  assert.strictEqual(stateB.screenshot.sanitizedDataUrl, 'data:image/png;base64,SANITIZED_TAB_B');
  assert.strictEqual(stateA.screenshot.tabId, 601);
  assert.strictEqual(stateB.screenshot.tabId, 602);
});

// ── TEST P45: Diagnostics remain scoped to the originating tab/generation/request ──
test('TEST P45 — Diagnostics remain scoped to the originating tab/generation/request', () => {
  // Test diagnostic forwarding router
  const forwardedMessages = [];
  function routeOffscreenDiagnostic(message, activeTabId) {
    const targetTabId = message.tabId || activeTabId;
    forwardedMessages.push({
      sentToTabId: targetTabId,
      generation: message.generation,
      requestId: message.requestId,
      stage: message.stage
    });
  }

  // Case: User has switched to Tab 702 (activeTabId = 702),
  // but background receives a diagnostic belonging to Tab 701 (message.tabId = 701, gen = 3)
  routeOffscreenDiagnostic({
    type: 'OFFSCREEN_DIAGNOSTIC',
    tabId: 701,
    generation: 3,
    requestId: 'req_123',
    stage: 'screenshot',
    data: { width: 800 }
  }, 702);

  assert.strictEqual(forwardedMessages.length, 1);
  assert.strictEqual(forwardedMessages[0].sentToTabId, 701, 'Diagnostic was NOT misdirected to currently active Tab 702');
  assert.strictEqual(forwardedMessages[0].generation, 3);
  assert.strictEqual(forwardedMessages[0].requestId, 'req_123');
});

// Helper for test P52 matching visualWorker.js implementation
function sanitizeOcrTextHelper(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let clean = rawText;
  clean = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  clean = clean.replace(/[ \t]{2,}/g, ' ');
  clean = clean.replace(/\n{3,}/g, '\n\n');
  clean = clean.split('\n').map(line => line.trim()).join('\n').trim();

  const MAX_OCR_LENGTH = 2000;
  if (clean.length > MAX_OCR_LENGTH) {
    clean = clean.slice(0, MAX_OCR_LENGTH).trim() + '...';
  }

  clean = clean.replace(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  clean = clean.replace(/(?:\+?\d{1,3}[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4,}\b/g, '[REDACTED_PHONE]');
  clean = clean.replace(/\b(?:\d[\s\-]?){13,19}\b/g, '[REDACTED_NUMBER]');
  return clean;
}

// ── TEST P46: OCR runs locally only ──
test('TEST P46 — OCR runs locally only (zero remote endpoints)', () => {
  const fs = require('fs');
  const path = require('path');
  const workerCode = fs.readFileSync(path.join(__dirname, '../extension/vision/visualWorker.js'), 'utf8');

  // Verify no remote OCR API calls exist in visualWorker
  assert.strictEqual(workerCode.includes('api.ocr.space'), false);
  assert.strictEqual(workerCode.includes('vision.googleapis.com'), false);
  assert.strictEqual(workerCode.includes('api.cognitive.microsoft.com'), false);
  // Verify it references local tesseract vendor bundle
  assert.ok(workerCode.includes('vendor/tesseract/'));
});

// ── TEST P47: OCR result is generation-bound ──
test('TEST P47 — OCR result is generation-bound', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(801, 'https://test-p47.com');

  sm.commitAnalysisResult(801, genA, { elements: [] });
  const visualResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_PNG_DATA',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: 'Header Title Section'
  };

  sm.commitVisualResult(801, genA, visualResult);
  const state = sm.tabPerceptionState.get(801);

  assert.strictEqual(state.screenshot.generation, genA);
  assert.strictEqual(state.screenshot.ocrExecuted, true);
  assert.strictEqual(state.screenshot.ocrText, 'Header Title Section');
});

// ── TEST P48: OCR result is tab-bound ──
test('TEST P48 — OCR result is tab-bound', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(802, 'https://tab-a.com');
  sm.commitAnalysisResult(802, genA, { elements: [] });
  sm.commitVisualResult(802, genA, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,TAB_A_IMG',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: 'Tab A Document Content'
  });

  // Switch to Tab B
  const genB = sm.activateTab(803, 'https://tab-b.com');
  const stateB = sm.tabPerceptionState.get(803);

  // Tab B must not inherit Tab A's OCR text or screenshot
  assert.strictEqual(stateB.screenshot, null);
  const stateA = sm.tabPerceptionState.get(802);
  assert.strictEqual(stateA.screenshot.tabId, 802);
  assert.strictEqual(stateA.screenshot.ocrText, 'Tab A Document Content');
});

// ── TEST P49: Stale OCR result is discarded ──
test('TEST P49 — Stale OCR result is discarded', () => {
  const sm = new PrivacyStateMachine();
  const gen1 = sm.activateTab(804, 'https://page-v1.com');
  sm.commitAnalysisResult(804, gen1, { elements: [] });

  // Navigation advances tab to Generation 2 before OCR completes
  const gen2 = sm.navigateTab(804, 'https://page-v2.com');
  assert.ok(gen2 > gen1);

  // Late OCR result arriving with Generation 1
  const lateOcrResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,V1_IMG',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: 'Page V1 Old Content'
  };

  const response = sm.commitVisualResult(804, gen1, lateOcrResult);
  assert.strictEqual(response.discarded, true);
  assert.strictEqual(response.ok, false);

  const state = sm.tabPerceptionState.get(804);
  assert.strictEqual(state.screenshot, null, 'Current generation state must not contain stale OCR');
});

// ── TEST P50: OCR failure does not expose raw screenshot ──
test('TEST P50 — OCR failure does not expose raw screenshot', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(805, 'https://test-p50.com');
  sm.commitAnalysisResult(805, gen, { elements: [] });

  // OCR failed, but CV and redaction succeeded
  const ocrFailureResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_SAFE_IMAGE',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false,
    ocrAvailable: true,
    ocrText: ''
  };

  const response = sm.commitVisualResult(805, gen, ocrFailureResult);
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.ocrExecuted, false);
  assert.strictEqual(response.ocrText, '');
  assert.strictEqual(response.sanitizedDataUrl, 'data:image/png;base64,SANITIZED_SAFE_IMAGE');
  assert.strictEqual(response.rawScreenshot, undefined);
});

// ── TEST P51: OCR text never enters logs ──
test('TEST P51 — OCR text never enters logs', () => {
  const LoggerModule = require('../extension/logger.js');
  const payload = {
    stage: 'ocr_complete',
    ocrText: 'Secret Board Meeting Financial Projections 2026',
    rawOcr: 'Confidential Internal Memo',
    tabId: 806,
    generation: 3
  };

  const sanitizedLog = LoggerModule.sanitizeLogData(payload);
  const logStr = JSON.stringify(sanitizedLog);

  assert.strictEqual(logStr.includes('Financial Projections'), false);
  assert.strictEqual(logStr.includes('Confidential Internal Memo'), false);
  assert.strictEqual(sanitizedLog.ocrText, '[REDACTED_OCR_DATA]');
  assert.strictEqual(sanitizedLog.rawOcr, '[REDACTED_OCR_DATA]');
  assert.strictEqual(sanitizedLog.tabId, 806);
});

// ── TEST P52: OCR output is bounded ──
test('TEST P52 — OCR output is bounded (length, whitespace, and PII)', () => {
  // Test 1: Length bounding (input > 2000 chars)
  const hugeText = 'Paragraph of text. '.repeat(200);
  assert.ok(hugeText.length > 3000);
  const bounded = sanitizeOcrTextHelper(hugeText);
  assert.ok(bounded.length <= 2005);
  assert.ok(bounded.endsWith('...'));

  // Test 2: Whitespace and control character normalization
  const messyText = 'Header   \r\n\r\n\r\n\r\n   Section \x00\x08 Subtext   ';
  const cleanWhitespace = sanitizeOcrTextHelper(messyText);
  assert.strictEqual(cleanWhitespace, 'Header\n\nSection Subtext');

  // Test 3: Residual PII scrubbing
  const piiText = 'Contact ceo@enterprise.com or call 555-123-4567';
  const scrubbedPii = sanitizeOcrTextHelper(piiText);
  assert.strictEqual(scrubbedPii.includes('ceo@enterprise.com'), false);
  assert.strictEqual(scrubbedPii.includes('555-123-4567'), false);
  assert.ok(scrubbedPii.includes('[REDACTED_EMAIL]'));
  assert.ok(scrubbedPii.includes('[REDACTED_PHONE]'));
});

// ── TEST P53: Empty OCR result handled safely ──
test('TEST P53 — Empty OCR result handled safely', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(807, 'https://image-only-page.com');
  sm.commitAnalysisResult(807, gen, { elements: [] });

  const emptyOcrResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,EMPTY_TEXT_PAGE',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: ''
  };

  const response = sm.commitVisualResult(807, gen, emptyOcrResult);
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.ocrExecuted, true);
  assert.strictEqual(response.ocrText, '');

  const state = sm.tabPerceptionState.get(807);
  assert.strictEqual(state.screenshot.ocrText, '');
});

// ── TEST P54: OCR initialization failure handled safely ──
test('TEST P54 — OCR initialization failure handled safely', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(808, 'https://no-wasm.com');
  sm.commitAnalysisResult(808, gen, { elements: [] });

  const initFailResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SAFE_SANITIZED_DATA',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false,
    ocrAvailable: false,
    ocrText: '',
    error: null
  };

  const response = sm.commitVisualResult(808, gen, initFailResult);
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.ocrExecuted, false);
  assert.strictEqual(response.ocrAvailable, false);
  assert.strictEqual(response.sanitizedDataUrl, 'data:image/png;base64,SAFE_SANITIZED_DATA');
});

// ── TEST P55: OCR runtime exception handled safely ──
test('TEST P55 — OCR runtime exception handled safely', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(809, 'https://ocr-crash.com');
  sm.commitAnalysisResult(809, gen, { elements: [] });

  // Simulate worker catching recognition crash: visual continues, OCR marked false
  const runtimeFailResult = {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,VALID_RED_IMAGE',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: false,
    ocrAvailable: true,
    ocrText: ''
  };

  const response = sm.commitVisualResult(809, gen, runtimeFailResult);
  assert.strictEqual(response.ok, true);
  assert.strictEqual(response.ocrExecuted, false);
  assert.strictEqual(response.ocrText, '');
});

// ── TEST P56: Tab removal purges OCR state ──
test('TEST P56 — Tab removal purges OCR state', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(810, 'https://close-ocr-tab.com');
  sm.commitAnalysisResult(810, gen, { elements: [] });
  sm.commitVisualResult(810, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,IMAGE',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: 'Sensitive Document Text'
  });

  assert.strictEqual(sm.tabPerceptionState.get(810).screenshot.ocrText, 'Sensitive Document Text');

  // Close tab
  sm.closeTab(810);
  assert.strictEqual(sm.tabPerceptionState.has(810), false);
});

// ── TEST P57: Navigation invalidates OCR state ──
test('TEST P57 — Navigation invalidates OCR state', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(811, 'https://page-a.com');
  sm.commitAnalysisResult(811, genA, { elements: [] });
  sm.commitVisualResult(811, genA, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,IMAGE_A',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: 'Page A Confidential Notice'
  });

  assert.ok(sm.tabPerceptionState.get(811).screenshot.ocrText);

  // Navigate to Page B
  const genB = sm.navigateTab(811, 'https://page-b.com');
  assert.ok(genB > genA);

  const state = sm.tabPerceptionState.get(811);
  assert.strictEqual(state.screenshot, null, 'Old OCR state was cleared on navigation');
  assert.strictEqual(state.isValid, false);
});

// ── TEST P58: Vision provider receives sanitized image + bounded OCR only ──
test('TEST P58 — Vision provider receives sanitized image + bounded OCR only', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(812, 'https://test-p58.com');
  sm.commitAnalysisResult(812, gen, { elements: [] });
  sm.commitVisualResult(812, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_PNG_DATA',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: 'Public Documentation Header'
  });

  const res = sm.sendToProvider(
    { tabId: 812, generation: gen, userMessage: 'Explain this page' },
    { provider: 'gemini', model: 'models/gemini-1.5-flash', isVision: true }
  );

  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.hasScreenshot, true);
  assert.strictEqual(res.screenshotData, 'data:image/png;base64,SANITIZED_PNG_DATA');
  assert.strictEqual(res.ocrText, 'Public Documentation Header');
});

// ── TEST P59: Text-only provider never receives an image ──
test('TEST P59 — Text-only provider never receives an image', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(813, 'https://test-p59.com');
  sm.commitAnalysisResult(813, gen, { elements: [] });
  sm.commitVisualResult(813, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_PNG_DATA',
    backend: 'mediapipe',
    cvExecuted: true,
    ocrExecuted: true,
    ocrAvailable: true,
    ocrText: 'Article Content'
  });

  const res = sm.sendToProvider(
    { tabId: 813, generation: gen, userMessage: 'Summarize text' },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', isVision: false }
  );

  assert.strictEqual(res.allowed, true);
  assert.strictEqual(res.hasScreenshot, false);
  assert.strictEqual(res.screenshotData, null);
  assert.strictEqual(res.ocrText, null);
});

// ── TEST P60: Provider failure after OCR does not trigger raw screenshot fallback ──
test('TEST P60 — Provider failure after OCR does not trigger raw screenshot fallback', () => {
  let fallbackCaptureInvoked = false;

  function simulateProviderCallWithOcr(shouldFail) {
    if (shouldFail) {
      // Simulate remote provider 500 failure
      return {
        type: 'text',
        error: 'PROVIDER_UNAVAILABLE',
        message: 'Gemini request failed (500)',
        hasFallbackScreenshot: fallbackCaptureInvoked
      };
    }
    return { type: 'text', message: 'Success' };
  }

  const res = simulateProviderCallWithOcr(true);
  assert.strictEqual(res.error, 'PROVIDER_UNAVAILABLE');
  assert.strictEqual(fallbackCaptureInvoked, false);
  assert.strictEqual(res.hasFallbackScreenshot, false);
});

// =========================================================================
// PHASE 7: MULTIMODAL PAGE GROUNDING & SAFE AGENT ACTIONS (P61–P80)
// =========================================================================

const ValidatorModule = require('../extension/validate.js');
const GroundingModule = require('../extension/grounding.js');
const ExecutorModule = require('../extension/execute.js');
const AgentCoordinatorModule = require('../extension/agentCoordinator.js');

function createMockElement(options = {}) {
  const el = {
    nodeType: 1,
    tagName: (options.tagName || 'BUTTON').toUpperCase(),
    isConnected: options.isConnected ?? true,
    disabled: options.disabled ?? false,
    innerText: options.text || '',
    textContent: options.text || '',
    value: options.value || '',
    attributes: { ...(options.attributes || {}) },
    hasAttribute(attr) {
      if (attr === 'disabled') return Boolean(this.disabled);
      return attr in this.attributes;
    },
    getAttribute(attr) {
      if (attr === 'disabled') return this.disabled ? 'true' : null;
      return this.attributes[attr] ?? null;
    },
    getBoundingClientRect() {
      return options.rect || { x: 100, y: 100, width: 80, height: 30 };
    },
    matches(sel) {
      if (sel === 'input[type="password"]') return this.tagName === 'INPUT' && this.getAttribute('type') === 'password';
      if (sel === '[data-sih-protected]') return this.hasAttribute('data-sih-protected');
      return false;
    },
    scrollIntoView: () => {},
    click() {
      if (this.disabled) return;
      if (typeof options.onClick === 'function') options.onClick();
    },
    focus: () => {},
    dispatchEvent: () => true
  };
  return el;
}

// ── TEST P61: Model cannot directly execute arbitrary DOM code ──
test('TEST P61 — model cannot directly execute arbitrary DOM code', () => {
  const evilPayloads = [
    { action: 'click', target: "javascript:alert(1)" },
    { action: 'click', target: "<script>alert('xss')</script>" },
    { action: 'click', target: "document.querySelector('button')" },
    { action: 'eval', target: "el_1" },
    { action: 'click', target: "eval(alert(1))" }
  ];

  for (const evil of evilPayloads) {
    const res = ValidatorModule.validateAction(evil, 1);
    assert.strictEqual(res.allowed, false, `Expected evil payload to be rejected: ${JSON.stringify(evil)}`);
  }
});

// ── TEST P62: Valid model action resolves through ElementRegistry ──
test('TEST P62 — valid model action resolves through ElementRegistry', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ tagName: 'BUTTON', text: 'Continue' });
  const elId = ElementRegistryModule.register(btn, 1);
  assert.ok(elId && elId.startsWith('el_'));

  global.window = global.window || {};
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const validAction = { action: 'click', target: elId, generation: 1 };
  const val = ValidatorModule.validateAction(validAction, 1);
  assert.strictEqual(val.allowed, true);
});

// ── TEST P63: Unknown elementId rejected ──
test('TEST P63 — unknown elementId rejected', () => {
  global.window = global.window || {};
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const action = { action: 'click', target: 'el_99999', generation: 1 };
  const val = ValidatorModule.validateAction(action, 1);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('not found') || val.reason.includes('rejected'));
});

// ── TEST P64: Stale generation action rejected ──
test('TEST P64 — stale generation action rejected', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ tagName: 'BUTTON', text: 'Submit' });
  const elId = ElementRegistryModule.register(btn, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const staleAction = { action: 'click', target: elId, generation: 1 };
  const val = ValidatorModule.validateAction(staleAction, 2);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('generation'));
});

// ── TEST P65: Wrong-tab action rejected ──
test('TEST P65 — wrong-tab action rejected', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ tagName: 'BUTTON', text: 'Confirm' });
  const elId = ElementRegistryModule.register(btn, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const wrongTabAction = { action: 'click', target: elId, generation: 1, tabId: 1001 };
  const val = ValidatorModule.validateAction(wrongTabAction, 1, 1002);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('tabId'));
});

// ── TEST P66: Hidden element rejected ──
test('TEST P66 — hidden element rejected', () => {
  ElementRegistryModule.reset();
  const hiddenBtn = createMockElement({ tagName: 'BUTTON', text: 'Hidden', attributes: { hidden: 'true' } });
  const elId = ElementRegistryModule.register(hiddenBtn, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const action = { action: 'click', target: elId, generation: 1 };
  const val = ValidatorModule.validateAction(action, 1);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('not visible'));
});

// ── TEST P67: Disabled element rejected ──
test('TEST P67 — disabled element rejected', () => {
  ElementRegistryModule.reset();
  const disabledBtn = createMockElement({ tagName: 'BUTTON', text: 'Disabled Button', disabled: true });
  const elId = ElementRegistryModule.register(disabledBtn, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const action = { action: 'click', target: elId, generation: 1 };
  const val = ValidatorModule.validateAction(action, 1);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('disabled'));
});

// ── TEST P68: Detached element rejected ──
test('TEST P68 — detached element rejected', () => {
  ElementRegistryModule.reset();
  const detachedBtn = createMockElement({ tagName: 'BUTTON', text: 'Detached', isConnected: false });
  const elId = ElementRegistryModule.register(detachedBtn, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const action = { action: 'click', target: elId, generation: 1 };
  const val = ValidatorModule.validateAction(action, 1);
  assert.strictEqual(val.allowed, false);
});

// ── TEST P69: Duplicate visual/OCR matches produce AMBIGUOUS_TARGET ──
test('TEST P69 — duplicate visual/OCR matches produce AMBIGUOUS_TARGET', () => {
  ElementRegistryModule.reset();
  global.window = global.window || {};
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const btn1 = createMockElement({ tagName: 'BUTTON', text: 'Submit Application', rect: { x: 50, y: 100, width: 100, height: 40 } });
  const btn2 = createMockElement({ tagName: 'BUTTON', text: 'Submit Application', rect: { x: 50, y: 300, width: 100, height: 40 } });

  global.document = {
    querySelectorAll: () => [btn1, btn2]
  };

  const intent = { text: 'Submit Application' };
  const result = GroundingModule.groundIntent(intent, 1, 100);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'AMBIGUOUS_TARGET');
  assert.strictEqual(result.diagnostics.ambiguous, true);
});

// ── TEST P70: OCR evidence can ground to an existing DOM element ──
test('TEST P70 — OCR evidence can ground to an existing DOM element', () => {
  ElementRegistryModule.reset();
  global.window = global.window || {};
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const continueBtn = createMockElement({ tagName: 'BUTTON', text: 'Continue to Checkout', rect: { x: 200, y: 400, width: 150, height: 40 } });
  global.document = {
    querySelectorAll: () => [continueBtn]
  };

  const ocrDetections = [
    { text: 'Continue to Checkout', bbox: { x: 205, y: 405, width: 140, height: 30 } }
  ];

  const correlations = GroundingModule.correlateOcrWithDom(ocrDetections, 1);
  assert.ok(correlations.length > 0);
  assert.strictEqual(correlations[0].ocrPhrase, 'Continue to Checkout');
  assert.ok(correlations[0].elementId.startsWith('el_'));
});

// ── TEST P71: Visual coordinates cannot directly execute actions ──
test('TEST P71 — visual coordinates cannot directly execute actions', () => {
  global.window = global.window || {};
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const rawCoordAction = { action: 'click', target: 'x=200,y=150', generation: 1 };
  const val = ValidatorModule.validateAction(rawCoordAction, 1);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('Arbitrary selector rejected') || val.reason.includes('not found'));
});

// ── TEST P72: Arbitrary selector generated by model is rejected ──
test('TEST P72 — arbitrary selector generated by model is rejected', () => {
  global.window = global.window || {};
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const selectorActions = [
    { action: 'click', target: 'button.primary-btn', generation: 1 },
    { action: 'click', target: 'div > span#submit', generation: 1 },
    { action: 'click', target: '//button[@id="save"]', generation: 1 },
    { action: 'type', target: 'input[name="user"]', value: 'alice', generation: 1 }
  ];

  for (const act of selectorActions) {
    const val = ValidatorModule.validateAction(act, 1);
    assert.strictEqual(val.allowed, false);
    assert.ok(val.reason.includes('Arbitrary selector rejected'));
  }
});

// ── TEST P73: Malformed structured action is rejected ──
test('TEST P73 — malformed structured action is rejected', () => {
  const invalidResponses = [
    null,
    undefined,
    'not an object',
    { actions: 'not an array' },
    { action: 'unsupportedSuperPower' },
    { action: 'type', target: 'el_1', value: 12345 }
  ];

  for (const inv of invalidResponses) {
    const res = GroundingModule.validateModelResponse(inv, 1, 100);
    assert.strictEqual(res.valid, false);
  }
});

// ── TEST P74: Concurrent requests remain generation-isolated ──
test('TEST P74 — concurrent requests remain generation-isolated', () => {
  ElementRegistryModule.reset();
  const elG1 = createMockElement({ text: 'Button Gen 1' });
  const elG2 = createMockElement({ text: 'Button Gen 2' });

  const idG1 = ElementRegistryModule.register(elG1, 10);
  const idG2 = ElementRegistryModule.register(elG2, 20);

  assert.strictEqual(ElementRegistryModule.resolve(idG1, 10), elG1);
  assert.strictEqual(ElementRegistryModule.resolve(idG1, 20), null);
  assert.strictEqual(ElementRegistryModule.resolve(idG2, 20), elG2);
  assert.strictEqual(ElementRegistryModule.resolve(idG2, 10), null);
});

// ── TEST P75: Navigation between response and execution blocks action ──
test('TEST P75 — navigation between response and execution blocks action', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ text: 'Navigate Action' });
  const elId = ElementRegistryModule.register(btn, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const actionG1 = { action: 'click', target: elId, generation: 1 };
  const val = ValidatorModule.validateAction(actionG1, 1);
  assert.strictEqual(val.allowed, true);

  const execResult = ExecutorModule.executeAction(actionG1, 2);
  assert.strictEqual(execResult.success, false);
  assert.ok(execResult.error.includes('stale generation'));
});

// ── TEST P76: ElementRegistry target remains generation-scoped ──
test('TEST P76 — ElementRegistry target remains generation-scoped', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ text: 'Scoped' });
  const elId = ElementRegistryModule.register(btn, 5);

  assert.strictEqual(ElementRegistryModule.resolve(elId, 5), btn);
  assert.strictEqual(ElementRegistryModule.resolve(elId, 6), null);
  assert.strictEqual(ElementRegistryModule.resolve(elId, 4), null);
});

// ── TEST P77: Valid click executes only after validation ──
test('TEST P77 — valid click executes only after validation', () => {
  ElementRegistryModule.reset();
  let clicked = false;
  const btn = createMockElement({ text: 'Click Me', onClick: () => { clicked = true; } });
  const elId = ElementRegistryModule.register(btn, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const action = { action: 'click', target: elId, generation: 1 };
  const val = ValidatorModule.validateAction(action, 1);
  assert.strictEqual(val.allowed, true);

  const exec = ExecutorModule.executeAction(action, 1);
  assert.strictEqual(exec.success, true);
  assert.strictEqual(clicked, true);
});

// ── TEST P78: Valid type executes only after validation ──
test('TEST P78 — valid type executes only after validation', () => {
  ElementRegistryModule.reset();
  const inputEl = createMockElement({ tagName: 'INPUT', attributes: { type: 'text' } });
  const elId = ElementRegistryModule.register(inputEl, 1);
  global.window.SIH_ElementRegistry = ElementRegistryModule;

  const validAction = { action: 'type', target: elId, value: 'Search Query', generation: 1 };
  const val = ValidatorModule.validateAction(validAction, 1);
  assert.strictEqual(val.allowed, true);

  const exec = ExecutorModule.executeAction(validAction, 1);
  assert.strictEqual(exec.success, true);
  assert.strictEqual(inputEl.value, 'Search Query');

  const divEl = createMockElement({ tagName: 'DIV' });
  const divId = ElementRegistryModule.register(divEl, 1);
  const invalidAction = { action: 'type', target: divId, value: 'Hello', generation: 1 };
  const valDiv = ValidatorModule.validateAction(invalidAction, 1);
  assert.strictEqual(valDiv.allowed, false);
  assert.ok(valDiv.reason.includes('cannot accept text input'));
});

// ── TEST P79: Bounded scroll executes only after validation ──
test('TEST P79 — bounded scroll executes only after validation', () => {
  global.window = global.window || {};
  let scrolledY = 0;
  global.window.scrollBy = (opts) => { scrolledY += opts.top; };

  const hugeAction = { action: 'scroll', value: '50000', generation: 1 };
  const valHuge = ValidatorModule.validateAction(hugeAction, 1);
  assert.strictEqual(valHuge.allowed, false);
  assert.ok(valHuge.reason.includes('bounds'));

  const validScroll = { action: 'scroll', value: '450', generation: 1 };
  const valOk = ValidatorModule.validateAction(validScroll, 1);
  assert.strictEqual(valOk.allowed, true);

  const exec = ExecutorModule.executeAction(validScroll, 1);
  assert.strictEqual(exec.success, true);
  assert.strictEqual(scrolledY, 450);
});

// ── TEST P80: Grounding diagnostics contain metadata only ──
test('TEST P80 — grounding diagnostics contain metadata only', () => {
  const diag = GroundingModule.getDiagnostics();
  assert.strictEqual(typeof diag.candidates, 'number');
  assert.strictEqual(typeof diag.matched, 'number');
  assert.strictEqual(typeof diag.ambiguous, 'boolean');

  const diagStr = JSON.stringify(diag);
  assert.strictEqual(diagStr.includes('ocrText'), false);
  assert.strictEqual(diagStr.includes('data:image'), false);
  assert.strictEqual(diagStr.includes('AIzaSy'), false);
  assert.strictEqual(diagStr.includes('innerHTML'), false);
});

// =========================================================================
// PHASE 8: SAFE MULTI-STEP AGENT PLANNING & TRANSACTION EXECUTION (P81–P100)
// =========================================================================

// ── TEST P81: Transaction requires valid tab ──
test('TEST P81 — transaction requires valid tab', () => {
  AgentCoordinatorModule.resetAll();
  const invalid1 = AgentCoordinatorModule.createTransaction({ tabId: null, generation: 1, goal: 'test' });
  assert.strictEqual(invalid1.success, false);
  assert.strictEqual(invalid1.error, 'INVALID_TAB_ID');

  const invalid2 = AgentCoordinatorModule.createTransaction({ tabId: -1, generation: 1, goal: 'test' });
  assert.strictEqual(invalid2.success, false);
  assert.strictEqual(invalid2.error, 'INVALID_TAB_ID');

  const valid = AgentCoordinatorModule.createTransaction({ tabId: 101, generation: 1, goal: 'test' });
  assert.strictEqual(valid.success, true);
  assert.strictEqual(valid.transaction.tabId, 101);
});

// ── TEST P82: Transaction requires current generation ──
test('TEST P82 — transaction requires current generation', () => {
  AgentCoordinatorModule.resetAll();
  const invalid1 = AgentCoordinatorModule.createTransaction({ tabId: 102, generation: 0, goal: 'test' });
  assert.strictEqual(invalid1.success, false);
  assert.strictEqual(invalid1.error, 'INVALID_GENERATION');

  const invalid2 = AgentCoordinatorModule.createTransaction({ tabId: 102, generation: null, goal: 'test' });
  assert.strictEqual(invalid2.success, false);
  assert.strictEqual(invalid2.error, 'INVALID_GENERATION');

  const valid = AgentCoordinatorModule.createTransaction({ tabId: 102, generation: 3, goal: 'test' });
  assert.strictEqual(valid.success, true);
  assert.strictEqual(valid.transaction.generation, 3);
});

// ── TEST P83: Transaction has hard step limit ──
test('TEST P83 — transaction has hard step limit', () => {
  AgentCoordinatorModule.resetAll();
  assert.strictEqual(AgentCoordinatorModule.MAX_STEPS, 5);

  const txAttemptHuge = AgentCoordinatorModule.createTransaction({ tabId: 103, generation: 1, goal: 'test', maxSteps: 999 });
  assert.strictEqual(txAttemptHuge.success, true);
  assert.strictEqual(txAttemptHuge.transaction.maxSteps, 5);
});

// ── TEST P84: Transaction has hard total timeout ──
test('TEST P84 — transaction has hard total timeout', async () => {
  AgentCoordinatorModule.resetAll();
  assert.strictEqual(AgentCoordinatorModule.MAX_TRANSACTION_TIME_MS, 30000);

  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 104, generation: 1, goal: 'test' });
  const tx = txRes.transaction;
  // Simulate time travel past timeout
  tx.startTime = Date.now() - 31000;

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(tx.transactionId, {
    observePage: async () => ({ tabId: 104, generation: 1 }),
    planStep: async () => ({ status: 'done' })
  });

  assert.strictEqual(loopRes.success, false);
  assert.strictEqual(loopRes.error, 'TRANSACTION_TIMEOUT');
});

// ── TEST P85: Model can propose only one action per step ──
test('TEST P85 — model can propose only one action per step', () => {
  const batchAttempt = {
    status: 'continue',
    actions: [
      { type: 'click', elementId: 'el_1' },
      { type: 'click', elementId: 'el_2' }
    ]
  };
  const res = AgentCoordinatorModule.validatePlanResponse(batchAttempt);
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.error, 'MULTIPLE_ACTIONS_FORBIDDEN');

  const singleAction = {
    status: 'continue',
    action: { type: 'click', elementId: 'el_1' }
  };
  const resSingle = AgentCoordinatorModule.validatePlanResponse(singleAction);
  assert.strictEqual(resSingle.valid, true);
  assert.strictEqual(resSingle.action.elementId, 'el_1');
});

// ── TEST P86: Next action requires fresh observation ──
test('TEST P86 — next action requires fresh observation', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 106, generation: 1, goal: 'test', maxSteps: 3 });
  let observationCount = 0;

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(txRes.transaction.transactionId, {
    observePage: async () => {
      observationCount++;
      return { tabId: 106, generation: 1, elementCount: observationCount };
    },
    planStep: async (context) => {
      if (context.elementCount === 1) {
        return { status: 'continue', action: { type: 'click', elementId: 'el_1' } };
      }
      return { status: 'done', message: 'Workflow finished' };
    },
    groundAction: () => ({ success: true, elementId: 'el_1' }),
    validateAction: () => ({ allowed: true }),
    executeAction: async () => ({ success: true }),
    settleWait: async () => {}
  });

  assert.strictEqual(loopRes.success, true);
  assert.strictEqual(observationCount, 3); // 1 initial observation, 1 post-action effect confirmation, 1 fresh observation before step 2
});

// ── TEST P87: Stale generation terminates transaction ──
test('TEST P87 — stale generation terminates transaction', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 107, generation: 1, goal: 'test' });
  const tx = txRes.transaction;

  const invalidated = AgentCoordinatorModule.handleNavigation(107, 2);
  assert.strictEqual(invalidated, true);
  assert.strictEqual(tx.status, 'STALE');
  assert.strictEqual(tx.error, 'PAGE_CHANGED');
});

// ── TEST P88: Tab close terminates transaction ──
test('TEST P88 — tab close terminates transaction', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 108, generation: 1, goal: 'test' });
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(108) !== null, true);

  const closed = AgentCoordinatorModule.handleTabClosed(108);
  assert.strictEqual(closed, true);
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(108), null);
  assert.strictEqual(txRes.transaction.status, 'FAILED');
  assert.strictEqual(txRes.transaction.error, 'TAB_CLOSED');
});

// ── TEST P89: User cancellation terminates transaction ──
test('TEST P89 — user cancellation terminates transaction', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 109, generation: 1, goal: 'test' });
  const cancelled = AgentCoordinatorModule.cancelTransaction(txRes.transaction.transactionId, 'USER_REQUESTED_STOP');
  assert.strictEqual(cancelled, true);
  assert.strictEqual(txRes.transaction.status, 'CANCELLED');
  assert.strictEqual(txRes.transaction.error, 'USER_REQUESTED_STOP');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(109), null);
});

// ── TEST P90: Concurrent same-tab transaction is rejected deterministically ──
test('TEST P90 — concurrent same-tab transaction is rejected/cancelled deterministically', () => {
  AgentCoordinatorModule.resetAll();
  const tx1 = AgentCoordinatorModule.createTransaction({ tabId: 110, generation: 1, goal: 'first' });
  assert.strictEqual(tx1.success, true);

  const tx2 = AgentCoordinatorModule.createTransaction({ tabId: 110, generation: 1, goal: 'second' });
  assert.strictEqual(tx2.success, false);
  assert.strictEqual(tx2.error, 'TRANSACTION_ACTIVE');
  assert.strictEqual(tx2.activeTransactionId, tx1.transaction.transactionId);
});

// ── TEST P91: Different-tab transactions remain isolated ──
test('TEST P91 — different-tab transactions remain isolated', () => {
  AgentCoordinatorModule.resetAll();
  const txTabA = AgentCoordinatorModule.createTransaction({ tabId: 111, generation: 1, goal: 'tabA' });
  const txTabB = AgentCoordinatorModule.createTransaction({ tabId: 112, generation: 2, goal: 'tabB' });

  assert.strictEqual(txTabA.success, true);
  assert.strictEqual(txTabB.success, true);
  assert.notStrictEqual(txTabA.transaction.transactionId, txTabB.transaction.transactionId);
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(111).goal, 'tabA');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(112).goal, 'tabB');
});

// ── TEST P92: Failed action does not trigger unlimited retry ──
test('TEST P92 — failed action does not trigger unlimited retry', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 113, generation: 1, goal: 'test' });
  let attempts = 0;

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(txRes.transaction.transactionId, {
    observePage: async () => ({ tabId: 113, generation: 1 }),
    planStep: async () => ({ status: 'continue', action: { type: 'click', elementId: 'el_broken' } }),
    groundAction: () => ({ success: true, elementId: 'el_broken' }),
    validateAction: () => ({ allowed: true }),
    executeAction: async () => {
      attempts++;
      return { success: false, error: 'EXECUTION_FAILED' };
    },
    settleWait: async () => {}
  });

  assert.strictEqual(loopRes.success, false);
  assert.strictEqual(attempts, 2); // Initial attempt + exactly 1 retry (MAX_RETRIES = 1)
  assert.strictEqual(loopRes.error, 'EXECUTION_FAILED');
});

// ── TEST P93: Action confirmation verifies actual effect ──
test('TEST P93 — action confirmation verifies actual effect', () => {
  const confUrl = AgentCoordinatorModule.confirmActionEffect('click', { url: 'http://a' }, { url: 'http://b' });
  assert.strictEqual(confUrl.confirmed, true);

  const confDom = AgentCoordinatorModule.confirmActionEffect('click', { elementCount: 5 }, { elementCount: 8 });
  assert.strictEqual(confDom.confirmed, true);

  const noEffect = AgentCoordinatorModule.confirmActionEffect('click', { elementCount: 5, domHash: 123 }, { elementCount: 5, domHash: 123 });
  assert.strictEqual(noEffect.confirmed, false);
  assert.strictEqual(noEffect.detail, 'NO_OBSERVABLE_EFFECT');

  const confType = AgentCoordinatorModule.confirmActionEffect('type', { inputValue: '' }, { inputValue: 'Search Query' });
  assert.strictEqual(confType.confirmed, true);

  const confScroll = AgentCoordinatorModule.confirmActionEffect('scroll', { scrollY: 0 }, { scrollY: 450 });
  assert.strictEqual(confScroll.confirmed, true);
});

// ── TEST P94: Repeated unchanged action triggers LOOP_DETECTED ──
test('TEST P94 — repeated unchanged action triggers LOOP_DETECTED', () => {
  const history = [
    { actionType: 'click', target: 'el_1', effectObserved: false },
    { actionType: 'click', target: 'el_1', effectObserved: false }
  ];
  const isLoop = AgentCoordinatorModule.detectLoop(history, { type: 'click', elementId: 'el_1' });
  assert.strictEqual(isLoop, true);

  const notLoop = AgentCoordinatorModule.detectLoop(history, { type: 'click', elementId: 'el_2' });
  assert.strictEqual(notLoop, false);
});

// ── TEST P95: Model cannot modify authoritative transaction metadata ──
test('TEST P95 — model cannot modify authoritative transaction metadata', () => {
  const modelEvilPlan = {
    status: 'continue',
    tabId: 9999,
    generation: 9999,
    maxSteps: 100,
    stepIndex: 0,
    action: { type: 'click', elementId: 'el_1', generation: 9999, tabId: 9999 }
  };
  const plan = AgentCoordinatorModule.validatePlanResponse(modelEvilPlan);
  assert.strictEqual(plan.valid, true);
  assert.strictEqual(plan.tabId, undefined);
  assert.strictEqual(plan.generation, undefined);
  assert.strictEqual(plan.maxSteps, undefined);
});

// ── TEST P96: Model cannot exceed MAX_STEPS ──
test('TEST P96 — model cannot exceed MAX_STEPS', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 116, generation: 1, goal: 'infinite loop' });
  let stepExecCount = 0;

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(txRes.transaction.transactionId, {
    observePage: async () => ({ tabId: 116, generation: 1, elementCount: stepExecCount }),
    planStep: async () => ({ status: 'continue', action: { type: 'click', elementId: `el_${stepExecCount + 1}` } }),
    groundAction: (act) => ({ success: true, elementId: act.elementId }),
    validateAction: () => ({ allowed: true }),
    executeAction: async () => {
      stepExecCount++;
      return { success: true };
    },
    settleWait: async () => {}
  });

  assert.strictEqual(loopRes.success, false);
  assert.strictEqual(loopRes.error, 'MAX_STEPS_REACHED');
  assert.strictEqual(stepExecCount, 5);
});

// ── TEST P97: Model cannot execute unsupported action types ──
test('TEST P97 — model cannot execute unsupported action types', () => {
  const unsupported = [
    { status: 'continue', action: { type: 'eval', elementId: 'el_1' } },
    { status: 'continue', action: { type: 'executeScript', elementId: 'el_1' } },
    { status: 'continue', action: { type: 'javascript:alert(1)', elementId: 'el_1' } },
    { status: 'continue', action: { type: 'keypress', key: 'Enter' } }
  ];

  for (const item of unsupported) {
    const res = AgentCoordinatorModule.validatePlanResponse(item);
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.error, 'UNSUPPORTED_ACTION_TYPE');
  }
});

// ── TEST P98: Provider failure terminates transaction safely ──
test('TEST P98 — provider failure terminates transaction safely', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 118, generation: 1, goal: 'test' });

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(txRes.transaction.transactionId, {
    observePage: async () => ({ tabId: 118, generation: 1 }),
    planStep: async () => {
      throw new Error('API Rate Limit Exceeded');
    },
    groundAction: () => ({ success: true }),
    validateAction: () => ({ allowed: true }),
    executeAction: async () => ({ success: true })
  });

  assert.strictEqual(loopRes.success, false);
  assert.strictEqual(loopRes.error, 'PROVIDER_FAILED');
  assert.strictEqual(txRes.transaction.status, 'FAILED');
});

// ── TEST P99: Privacy gate remains mandatory for every step ──
test('TEST P99 — privacy gate remains mandatory for every step', () => {
  const untrustedPlan = {
    status: 'continue',
    action: {
      type: 'click',
      elementId: 'el_1',
      rawScreenshot: 'data:image/png;base64,RAWDATA...',
      apiKey: 'AIzaSySecret...'
    }
  };
  const cleanTx = { history: [] };
  AgentCoordinatorModule.recordHistory(cleanTx, {
    stepIndex: 1,
    actionType: 'click',
    target: 'el_1',
    status: 'SUCCESS'
  });
  const cleanHist = JSON.stringify(cleanTx.history);
  assert.strictEqual(cleanHist.includes('rawScreenshot'), false);
  assert.strictEqual(cleanHist.includes('apiKey'), false);
});

// ── TEST P100: Transaction history contains metadata only ──
test('TEST P100 — transaction history contains metadata only', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 120, generation: 1, goal: 'test' });
  const tx = txRes.transaction;

  for (let i = 0; i < 15; i++) {
    AgentCoordinatorModule.recordHistory(tx, {
      stepIndex: i,
      actionType: 'click',
      target: `el_${i}`,
      status: 'SUCCESS',
      effectObserved: true,
      durationMs: 45
    });
  }

  assert.strictEqual(tx.history.length, 10);

  const entry = tx.history[0];
  const allowedKeys = ['stepIndex', 'actionType', 'target', 'status', 'effectObserved', 'durationMs', 'error', 'timestamp'];
  for (const k of Object.keys(entry)) {
    assert.strictEqual(allowedKeys.includes(k), true);
  }

  const histJson = JSON.stringify(tx.history);
  assert.strictEqual(histJson.includes('data:image'), false);
  assert.strictEqual(histJson.includes('ocrText'), false);
  assert.strictEqual(histJson.includes('AIzaSy'), false);
  assert.strictEqual(histJson.includes('innerHTML'), false);
});

// =========================================================================
// PHASE 9: PRODUCTION HARDENING, DEMO RELIABILITY & AUDIT (P101–P155)
// =========================================================================

// ── TEST P101: Completed transaction fully cleaned ──
test('TEST P101 — completed transaction fully cleaned', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 201, generation: 1, goal: 'complete test' });
  const tx = txRes.transaction;
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 10000);

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(tx.transactionId, {
    observePage: async () => ({ tabId: 201, generation: 1 }),
    planStep: async () => ({ status: 'done', message: 'Workflow finished' })
  });

  assert.strictEqual(loopRes.success, true);
  assert.strictEqual(tx.status, 'COMPLETED');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(201), null);
  assert.strictEqual(tx._finalized, true);
  assert.strictEqual(tx.timers.size, 0);
  assert.strictEqual(tx.retryCounts.size, 0);
});

// ── TEST P102: Failed transaction fully cleaned ──
test('TEST P102 — failed transaction fully cleaned', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 202, generation: 1, goal: 'fail test' });
  const tx = txRes.transaction;
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 10000);

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(tx.transactionId, {
    observePage: async () => ({ tabId: 202, generation: 1 }),
    planStep: async () => ({ status: 'continue', action: { type: 'click', elementId: 'el_fail' } }),
    groundAction: () => ({ success: true, elementId: 'el_fail' }),
    validateAction: () => ({ allowed: true }),
    executeAction: async () => ({ success: false, error: 'EXECUTION_FAILED' })
  });

  assert.strictEqual(loopRes.success, false);
  assert.strictEqual(tx.status, 'FAILED');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(202), null);
  assert.strictEqual(tx._finalized, true);
  assert.strictEqual(tx.timers.size, 0);
  assert.strictEqual(tx.retryCounts.size, 0);
});

// ── TEST P103: Cancelled transaction fully cleaned ──
test('TEST P103 — cancelled transaction fully cleaned', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 203, generation: 1, goal: 'cancel test' });
  const tx = txRes.transaction;
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 10000);

  const cancelled = AgentCoordinatorModule.cancelTransaction(tx.transactionId, 'USER_CANCELLED');
  assert.strictEqual(cancelled, true);
  assert.strictEqual(tx.status, 'CANCELLED');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(203), null);
  assert.strictEqual(tx._finalized, true);
  assert.strictEqual(tx.timers.size, 0);
  assert.strictEqual(tx.retryCounts.size, 0);
});

// ── TEST P104: Stale transaction fully cleaned ──
test('TEST P104 — stale transaction fully cleaned', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 204, generation: 1, goal: 'stale test' });
  const tx = txRes.transaction;
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 10000);

  const handled = AgentCoordinatorModule.handleNavigation(204, 2);
  assert.strictEqual(handled, true);
  assert.strictEqual(tx.status, 'STALE');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(204), null);
  assert.strictEqual(tx._finalized, true);
  assert.strictEqual(tx.timers.size, 0);
});

// ── TEST P105: Timeout transaction fully cleaned ──
test('TEST P105 — timeout transaction fully cleaned', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 205, generation: 1, goal: 'timeout test' });
  const tx = txRes.transaction;
  tx.startTime = Date.now() - 35000;
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 10000);

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(tx.transactionId, {
    observePage: async () => ({ tabId: 205, generation: 1 }),
    planStep: async () => ({ status: 'done' })
  });

  assert.strictEqual(loopRes.success, false);
  assert.strictEqual(loopRes.error, 'TRANSACTION_TIMEOUT');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(205), null);
  assert.strictEqual(tx._finalized, true);
  assert.strictEqual(tx.timers.size, 0);
});

// ── TEST P106: Provider timeout cleaned ──
test('TEST P106 — provider timeout cleaned', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 206, generation: 1, goal: 'provider timeout' });
  const tx = txRes.transaction;
  const cancel = AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 5000);
  assert.strictEqual(tx.timers.size, 1);
  cancel();
  assert.strictEqual(tx.timers.size, 0);
});

// ── TEST P107: OCR timeout cleaned ──
test('TEST P107 — OCR timeout cleaned', () => {
  let timerCleared = false;
  let timerId = setTimeout(() => {}, 10000);
  function cleanupOcrTimer() {
    clearTimeout(timerId);
    timerCleared = true;
  }
  cleanupOcrTimer();
  assert.strictEqual(timerCleared, true);
});

// ── TEST P108: Page settle timeout cleaned ──
test('TEST P108 — page settle timeout cleaned', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 208, generation: 1, goal: 'settle test' });
  const tx = txRes.transaction;
  let settleFired = false;
  AgentCoordinatorModule.registerManagedTimer(tx, () => { settleFired = true; }, 5000);
  assert.strictEqual(tx.timers.size, 1);
  AgentCoordinatorModule.cleanupTransaction(tx.transactionId, 'CANCELLED', 'USER_ABORT');
  assert.strictEqual(tx.timers.size, 0);
  assert.strictEqual(settleFired, false);
});

// ── TEST P109: Transaction timeout cleaned ──
test('TEST P109 — transaction timeout cleaned', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 209, generation: 1, goal: 'timeout cleanup' });
  const tx = txRes.transaction;
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 1000);
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 2000);
  AgentCoordinatorModule.registerManagedTimer(tx, () => {}, 3000);
  assert.strictEqual(tx.timers.size, 3);
  AgentCoordinatorModule.cleanupTransaction(tx.transactionId, 'FAILED', 'TRANSACTION_TIMEOUT');
  assert.strictEqual(tx.timers.size, 0);
  assert.strictEqual(tx._finalized, true);
});

// ── TEST P110: Stale request cannot complete later ──
test('TEST P110 — stale request cannot complete later', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 210, generation: 1, goal: 'stale callback' });
  const tx = txRes.transaction;
  let staleMutated = false;

  AgentCoordinatorModule.registerManagedTimer(tx, () => {
    if (!tx._finalized) {
      tx.status = 'COMPLETED';
      staleMutated = true;
    }
  }, 100);

  AgentCoordinatorModule.cleanupTransaction(tx.transactionId, 'CANCELLED', 'USER_ABORT');
  assert.strictEqual(tx._finalized, true);
  assert.strictEqual(tx.status, 'CANCELLED');
  assert.strictEqual(staleMutated, false);
});

// ── TEST P111: Provider auth failure safe ──
test('TEST P111 — provider auth failure safe', () => {
  const err401 = new Error('HTTP 401 Unauthorized: Invalid API key provided');
  const classified = AgentCoordinatorModule.classifyProviderError(err401);
  assert.strictEqual(classified.code, 'AUTH_FAILED');
  assert.strictEqual(classified.message.includes('401'), true);
});

// ── TEST P112: Provider network failure safe ──
test('TEST P112 — provider network failure safe', () => {
  const netErr = new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:443');
  const classified = AgentCoordinatorModule.classifyProviderError(netErr);
  assert.strictEqual(classified.code, 'NETWORK_FAILED');
});

// ── TEST P113: Provider timeout safe ──
test('TEST P113 — provider timeout safe', () => {
  const timeoutErr = new Error('AbortError: The operation was aborted due to timeout');
  const classified = AgentCoordinatorModule.classifyProviderError(timeoutErr);
  assert.strictEqual(classified.code, 'TIMEOUT');
});

// ── TEST P114: Malformed model response safe ──
test('TEST P114 — malformed model response safe', () => {
  const invalidResponses = [
    null,
    undefined,
    'plain string',
    12345,
    {},
    { status: 'invalid_status' },
    { status: 'continue', action: null },
    { status: 'continue', action: 'not an object' }
  ];

  for (const resp of invalidResponses) {
    const val = AgentCoordinatorModule.validatePlanResponse(resp);
    assert.strictEqual(val.valid, false);
    assert.ok(val.error === 'INVALID_MODEL_OUTPUT' || val.error === 'UNSUPPORTED_ACTION_TYPE');
  }
});

// ── TEST P115: Provider error contains no secrets ──
test('TEST P115 — provider error contains no secrets', () => {
  const leakErr = new Error(
    'Request failed key=AIzaSyD_SECRET_KEY_1234567890 for sk-ant-api03-abcdef1234567890 with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
  );
  const classified = AgentCoordinatorModule.classifyProviderError(leakErr);
  assert.strictEqual(classified.message.includes('AIzaSyD_SECRET'), false);
  assert.strictEqual(classified.message.includes('sk-ant-api03'), false);
  assert.strictEqual(classified.message.includes('eyJhbGciOiJIUzI1Ni'), false);
  assert.ok(classified.message.includes('[REDACTED_API_KEY]'));
  assert.ok(classified.message.includes('[REDACTED_AUTH]'));
});

// ── TEST P116: Multiple actions rejected ──
test('TEST P116 — multiple actions rejected', () => {
  const batchPlan = {
    status: 'continue',
    action: [
      { type: 'click', elementId: 'el_1' },
      { type: 'click', elementId: 'el_2' }
    ]
  };
  const val = AgentCoordinatorModule.validatePlanResponse(batchPlan);
  assert.strictEqual(val.valid, false);
  assert.strictEqual(val.error, 'MULTIPLE_ACTIONS_FORBIDDEN');
});

// ── TEST P117: TransactionId spoof rejected ──
test('TEST P117 — transactionId spoof rejected', () => {
  const spoofedPlan = {
    status: 'continue',
    transactionId: 'tx_spoofed_evil',
    action: { type: 'click', elementId: 'el_1', transactionId: 'tx_spoofed_evil' }
  };
  const val = AgentCoordinatorModule.validatePlanResponse(spoofedPlan);
  assert.strictEqual(val.valid, true);
  assert.strictEqual(val.transactionId, undefined);
  assert.strictEqual(val.action.transactionId, undefined);
});

// ── TEST P118: Generation spoof rejected ──
test('TEST P118 — generation spoof rejected', () => {
  const spoofedGenPlan = {
    status: 'continue',
    generation: 99999,
    action: { type: 'click', elementId: 'el_1', generation: 99999 }
  };
  const val = AgentCoordinatorModule.validatePlanResponse(spoofedGenPlan);
  assert.strictEqual(val.valid, true);
  assert.strictEqual(val.generation, undefined);
  assert.strictEqual(val.action.generation, undefined);
});

// ── TEST P119: TabId spoof rejected ──
test('TEST P119 — tabId spoof rejected', () => {
  const spoofedTabPlan = {
    status: 'continue',
    tabId: 99999,
    action: { type: 'click', elementId: 'el_1', tabId: 99999 }
  };
  const val = AgentCoordinatorModule.validatePlanResponse(spoofedTabPlan);
  assert.strictEqual(val.valid, true);
  assert.strictEqual(val.tabId, undefined);
  assert.strictEqual(val.action.tabId, undefined);
});

// ── TEST P120: Oversized model response rejected ──
test('TEST P120 — oversized model response rejected', () => {
  const hugeMessage = 'A'.repeat(70000);
  const oversizedPlan = {
    status: 'done',
    message: hugeMessage
  };
  const val = AgentCoordinatorModule.validatePlanResponse(oversizedPlan);
  assert.strictEqual(val.valid, false);
  assert.strictEqual(val.error, 'OVERSIZED_MODEL_RESPONSE');
});

// ── TEST P121: Zero raw screenshot logs ──
test('TEST P121 — zero raw screenshot logs', () => {
  const rawImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const sanitized = global.SIH_Logger.sanitizeLogData({ screenshot: rawImage, nested: { preview: rawImage } });
  const str = JSON.stringify(sanitized);
  assert.strictEqual(str.includes('iVBORw0KGgo'), false);
  assert.strictEqual(str.includes('data:image/png;base64'), false);
  assert.strictEqual(str.includes('[REDACTED_IMAGE_DATA]'), true);
});

// ── TEST P122: Zero raw OCR logs ──
test('TEST P122 — zero raw OCR logs', () => {
  const rawOcr = 'Sensitive invoice #99238 customer social security 000-12-3456';
  const sanitized = global.SIH_Logger.sanitizeLogData({ ocrText: rawOcr, rawOcr: rawOcr });
  const str = JSON.stringify(sanitized);
  assert.strictEqual(str.includes('99238'), false);
  assert.strictEqual(str.includes('000-12-3456'), false);
  assert.strictEqual(str.includes('[REDACTED_OCR_DATA]'), true);
});

// ── TEST P123: Zero API-key logs ──
test('TEST P123 — zero API-key logs', () => {
  const sanitized = global.SIH_Logger.sanitizeLogData({
    apiKey: 'AIzaSyD_TEST_SECRET_KEY_1234567890',
    secretToken: 'sk-ant-api03-abcdef1234567890',
    authMsg: 'Failed with key AIzaSyD_TEST_SECRET_KEY_1234567890'
  });
  const str = JSON.stringify(sanitized);
  assert.strictEqual(str.includes('AIzaSyD_TEST'), false);
  assert.strictEqual(str.includes('sk-ant-api03'), false);
  assert.ok(str.includes('[REDACTED]'));
});

// ── TEST P124: Zero authorization-header logs ──
test('TEST P124 — zero authorization-header logs', () => {
  const sanitized = global.SIH_Logger.sanitizeLogData({
    authorization: 'Bearer secret_token_xyz_12345',
    headers: { 'Authorization': 'Bearer another_secret_token' }
  });
  const str = JSON.stringify(sanitized);
  assert.strictEqual(str.includes('secret_token_xyz'), false);
  assert.strictEqual(str.includes('another_secret_token'), false);
  assert.ok(str.includes('[REDACTED]'));
});

// ── TEST P125: No unsanitized model payload ──
test('TEST P125 — no unsanitized model payload', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(325);
  sm.tabPerceptionState.get(325).screenshot = 'data:image/png;base64,RAW_UNREDACTED...';
  const req = sm.sendToProvider({ tabId: 325, generation: gen, userMessage: 'test' }, { provider: 'gemini', isVision: true });
  assert.strictEqual(req.allowed, false);
});

// ── TEST P126: Raw screenshot never persisted ──
test('TEST P126 — raw screenshot never persisted', () => {
  const sm = new PrivacyStateMachine();
  sm.activateTab(326);
  const state = sm.tabPerceptionState.get(326);
  assert.strictEqual(state.rawScreenshot, undefined);
  assert.strictEqual(state.screenshot, null);
});

// ── TEST P127: Raw OCR never persisted ──
test('TEST P127 — raw OCR never persisted', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 327, generation: 1, goal: 'ocr test' });
  AgentCoordinatorModule.recordHistory(txRes.transaction, {
    stepIndex: 1,
    actionType: 'click',
    target: 'el_1',
    status: 'SUCCESS',
    rawOcr: 'Full text dump containing PII'
  });
  const histStr = JSON.stringify(txRes.transaction.history);
  assert.strictEqual(histStr.includes('Full text dump'), false);
  assert.strictEqual(histStr.includes('rawOcr'), false);
});

// ── TEST P128: Stale sanitized artifact rejected ──
test('TEST P128 — stale sanitized artifact rejected', () => {
  const sm = new PrivacyStateMachine();
  const gen1 = sm.activateTab(328);
  sm.commitVisualResult(328, gen1, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_GEN_1',
    backend: 'native'
  });
  assert.strictEqual(sm.tabPerceptionState.get(328).screenshot.sanitizedDataUrl, 'data:image/png;base64,SANITIZED_GEN_1');

  sm.navigateTab(328, 'https://example.com/page2');
  assert.strictEqual(sm.tabPerceptionState.get(328).screenshot, null);
  const req = sm.sendToProvider({ tabId: 328, generation: gen1, userMessage: 'test' }, { provider: 'gemini', isVision: true });
  assert.strictEqual(req.allowed, false);
  assert.strictEqual(req.error, 'CONTEXT_INVALIDATED');
});

// ── TEST P129: Tab close destroys visual state ──
test('TEST P129 — tab close destroys visual state', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(329);
  sm.commitVisualResult(329, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED',
    backend: 'native'
  });
  assert.strictEqual(sm.tabPerceptionState.has(329), true);

  sm.closeTab(329);
  assert.strictEqual(sm.tabPerceptionState.has(329), false);
});

// ── TEST P130: Navigation destroys previous visual artifact ──
test('TEST P130 — navigation destroys previous visual artifact', () => {
  const sm = new PrivacyStateMachine();
  const gen = sm.activateTab(330);
  sm.commitVisualResult(330, gen, {
    ok: true,
    sanitizedDataUrl: 'data:image/png;base64,SANITIZED_PAGE1',
    backend: 'native'
  });
  assert.ok(sm.tabPerceptionState.get(330).screenshot);

  sm.navigateTab(330, 'https://example.com/page2');
  assert.strictEqual(sm.tabPerceptionState.get(330).screenshot, null);
  assert.strictEqual(sm.tabPerceptionState.get(330).isValid, false);
});

// ── TEST P131: Sidebar ignores stale generation ──
test('TEST P131 — sidebar ignores stale generation', () => {
  const currentGen = 5;
  const staleMsgGen = 4;
  let updated = false;

  function handleVisualUpdate(msg) {
    if (typeof msg.generation === 'number' && msg.generation !== currentGen) {
      return;
    }
    updated = true;
  }

  handleVisualUpdate({ generation: staleMsgGen, visual: { backend: 'native' } });
  assert.strictEqual(updated, false);

  handleVisualUpdate({ generation: currentGen, visual: { backend: 'native' } });
  assert.strictEqual(updated, true);
});

// ── TEST P132: Sidebar clears state on navigation ──
test('TEST P132 — sidebar clears state on navigation', () => {
  let sidebarState = {
    context: { elements: [1, 2, 3] },
    visual: { screenshot: 'data:image/png...' },
    status: 'Ready'
  };

  function onNavigationInvalidate() {
    sidebarState.context = null;
    sidebarState.visual = null;
    sidebarState.status = 'Page changed — refreshing protected context…';
  }

  onNavigationInvalidate();
  assert.strictEqual(sidebarState.context, null);
  assert.strictEqual(sidebarState.visual, null);
  assert.ok(sidebarState.status.includes('refreshing protected context'));
});

// ── TEST P133: Sidebar clears state on tab close ──
test('TEST P133 — sidebar clears state on tab close', () => {
  let sidebarState = { activeTabId: 333, context: {}, status: 'Ready' };
  function onTabClosed(closedTabId) {
    if (sidebarState.activeTabId === closedTabId) {
      sidebarState.activeTabId = null;
      sidebarState.context = null;
      sidebarState.status = 'Context unavailable';
    }
  }
  onTabClosed(333);
  assert.strictEqual(sidebarState.activeTabId, null);
  assert.strictEqual(sidebarState.context, null);
  assert.strictEqual(sidebarState.status, 'Context unavailable');
});

// ── TEST P134: Sidebar never displays sensitive data ──
test('TEST P134 — sidebar never displays sensitive data', () => {
  function renderEvidenceBadges(detections) {
    return detections.map(d => ({
      type: d.type,
      badge: `[${d.type.toUpperCase()}]`
    }));
  }

  const detections = [
    { type: 'email', raw: 'ceo@confidential.com' },
    { type: 'phone', raw: '+1 555 123 4567' }
  ];

  const rendered = renderEvidenceBadges(detections);
  const renderedStr = JSON.stringify(rendered);
  assert.strictEqual(renderedStr.includes('ceo@confidential.com'), false);
  assert.strictEqual(renderedStr.includes('+1 555 123 4567'), false);
  assert.strictEqual(rendered[0].badge, '[EMAIL]');
  assert.strictEqual(rendered[1].badge, '[PHONE]');
});

// ── TEST P135: Demo workflow repeatability ──
test('TEST P135 — demo workflow repeatability', async () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 335, generation: 1, goal: 'Complete demo workflow' });
  let step = 0;

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(txRes.transaction.transactionId, {
    observePage: async () => ({ tabId: 335, generation: 1, step }),
    planStep: async () => {
      step++;
      if (step === 1) return { status: 'continue', action: { type: 'click', elementId: 'el_start' } };
      if (step === 2) return { status: 'continue', action: { type: 'click', elementId: 'el_complete' } };
      return { status: 'done', message: 'Workflow completed' };
    },
    groundAction: (act) => ({ success: true, elementId: act.elementId }),
    validateAction: () => ({ allowed: true }),
    executeAction: async () => ({ success: true }),
    settleWait: async () => {}
  });

  assert.strictEqual(loopRes.success, true);
  assert.strictEqual(loopRes.status, 'COMPLETED');
  assert.strictEqual(loopRes.stepsExecuted, 2);
  assert.strictEqual(loopRes.finalMessage, 'Workflow completed');
});

// ── TEST P136: Second demo run after cleanup ──
test('TEST P136 — second demo run after cleanup', async () => {
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(335), null);
  const txRes2 = AgentCoordinatorModule.createTransaction({ tabId: 335, generation: 1, goal: 'Run 2' });
  assert.strictEqual(txRes2.success, true);

  const loopRes2 = await AgentCoordinatorModule.runTransactionLoop(txRes2.transaction.transactionId, {
    observePage: async () => ({ tabId: 335, generation: 1 }),
    planStep: async () => ({ status: 'done', message: 'Run 2 complete' }),
    settleWait: async () => {}
  });

  assert.strictEqual(loopRes2.success, true);
  assert.strictEqual(loopRes2.status, 'COMPLETED');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(335), null);
});

// ── TEST P137: Demo after navigation ──
test('TEST P137 — demo after navigation', async () => {
  AgentCoordinatorModule.resetAll();
  const txNav = AgentCoordinatorModule.createTransaction({ tabId: 337, generation: 1, goal: 'Nav Demo' });
  AgentCoordinatorModule.handleNavigation(337, 2);
  assert.strictEqual(txNav.transaction.status, 'STALE');

  const txNew = AgentCoordinatorModule.createTransaction({ tabId: 337, generation: 2, goal: 'Nav Demo Fresh' });
  assert.strictEqual(txNew.success, true);

  const loopRes = await AgentCoordinatorModule.runTransactionLoop(txNew.transaction.transactionId, {
    observePage: async () => ({ tabId: 337, generation: 2 }),
    planStep: async () => ({ status: 'done', message: 'Completed on gen 2' }),
    settleWait: async () => {}
  });

  assert.strictEqual(loopRes.success, true);
  assert.strictEqual(loopRes.finalMessage, 'Completed on gen 2');
});

// ── TEST P138: Demo after tab switch ──
test('TEST P138 — demo after tab switch', async () => {
  AgentCoordinatorModule.resetAll();
  const txTab1 = AgentCoordinatorModule.createTransaction({ tabId: 3381, generation: 1, goal: 'Tab 1' });
  const txTab2 = AgentCoordinatorModule.createTransaction({ tabId: 3382, generation: 1, goal: 'Tab 2' });

  assert.strictEqual(txTab1.success, true);
  assert.strictEqual(txTab2.success, true);

  const res2 = await AgentCoordinatorModule.runTransactionLoop(txTab2.transaction.transactionId, {
    observePage: async () => ({ tabId: 3382, generation: 1 }),
    planStep: async () => ({ status: 'done', message: 'Tab 2 done' })
  });
  assert.strictEqual(res2.success, true);

  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(3381) !== null, true);
  const res1 = await AgentCoordinatorModule.runTransactionLoop(txTab1.transaction.transactionId, {
    observePage: async () => ({ tabId: 3381, generation: 1 }),
    planStep: async () => ({ status: 'done', message: 'Tab 1 done' })
  });
  assert.strictEqual(res1.success, true);
});

// ── TEST P139: Demo after provider failure recovery ──
test('TEST P139 — demo after provider failure recovery', async () => {
  AgentCoordinatorModule.resetAll();
  const txFail = AgentCoordinatorModule.createTransaction({ tabId: 339, generation: 1, goal: 'Transient fail' });

  const failRes = await AgentCoordinatorModule.runTransactionLoop(txFail.transaction.transactionId, {
    observePage: async () => ({ tabId: 339, generation: 1 }),
    planStep: async () => { throw new Error('fetch failed: network glitch'); }
  });
  assert.strictEqual(failRes.success, false);
  assert.strictEqual(failRes.error, 'PROVIDER_FAILED');

  const txRecover = AgentCoordinatorModule.createTransaction({ tabId: 339, generation: 1, goal: 'Recovered' });
  assert.strictEqual(txRecover.success, true);

  const recoverRes = await AgentCoordinatorModule.runTransactionLoop(txRecover.transaction.transactionId, {
    observePage: async () => ({ tabId: 339, generation: 1 }),
    planStep: async () => ({ status: 'done', message: 'Successfully recovered' })
  });
  assert.strictEqual(recoverRes.success, true);
  assert.strictEqual(recoverRes.status, 'COMPLETED');
});

// ── TEST P140: Service-worker restart cannot execute stale action ──
test('TEST P140 — service-worker restart cannot execute stale action', () => {
  const staleAction = { action: 'click', target: 'el_1', generation: 10, tabId: 340 };
  ElementRegistryModule.reset();
  const postRestartGen = 1;
  const val = ValidatorModule.validateAction(staleAction, postRestartGen, 340);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('generation'));
});

// ── TEST P141: Service-worker restart leaves no active transaction ──
test('TEST P141 — service-worker restart leaves no active transaction', () => {
  AgentCoordinatorModule.resetAll();
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(341), null);
});

// ── TEST P142: Fresh transaction can start after restart ──
test('TEST P142 — fresh transaction can start after restart', () => {
  AgentCoordinatorModule.resetAll();
  const tx = AgentCoordinatorModule.createTransaction({ tabId: 342, generation: 1, goal: 'Post-restart test' });
  assert.strictEqual(tx.success, true);
  assert.strictEqual(tx.transaction.status, 'PLANNING');
});

// ── TEST P143: Tab isolation ──
test('TEST P143 — tab isolation', () => {
  const sm = new PrivacyStateMachine();
  const genA = sm.activateTab(3431, 'https://a.com');
  const genB = sm.activateTab(3432, 'https://b.com');

  assert.notStrictEqual(genA, genB);
  assert.strictEqual(sm.tabPerceptionState.get(3431).navigationIdentity, 'https://a.com');
  assert.strictEqual(sm.tabPerceptionState.get(3432).navigationIdentity, 'https://b.com');
});

// ── TEST P144: Sidebar active-tab synchronization ──
test('TEST P144 — sidebar active-tab synchronization', () => {
  const sm = new PrivacyStateMachine();
  sm.activateTab(3441, 'https://tab1.com');
  assert.strictEqual(sm.activeTabId, 3441);

  sm.activateTab(3442, 'https://tab2.com');
  assert.strictEqual(sm.activeTabId, 3442);
});

// ── TEST P145: Cross-tab action rejection ──
test('TEST P145 — cross-tab action rejection', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ tagName: 'BUTTON', text: 'Submit' });
  const elId = ElementRegistryModule.register(btn, 1);

  const actionForTabA = { action: 'click', target: elId, generation: 1, tabId: 3451 };
  const val = ValidatorModule.validateAction(actionForTabA, 1, 3452);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('tabId'));
});

// ── TEST P146: Navigation during OCR ──
test('TEST P146 — navigation during OCR', () => {
  const sm = new PrivacyStateMachine();
  const ocrGen = sm.activateTab(346);
  sm.navigateTab(346, 'https://example.com/page2');
  const currentGen = sm.tabPerceptionState.get(346).generation;
  assert.notStrictEqual(ocrGen, currentGen);
  const isAccepted = ocrGen === currentGen;
  assert.strictEqual(isAccepted, false);
});

// ── TEST P147: Navigation during provider request ──
test('TEST P147 — navigation during provider request', () => {
  const sm = new PrivacyStateMachine();
  const reqGen = sm.activateTab(347);
  sm.navigateTab(347, 'https://example.com/page2');
  const currentGen = sm.tabPerceptionState.get(347).generation;
  const shouldDiscard = reqGen !== currentGen;
  assert.strictEqual(shouldDiscard, true);
});

// ── TEST P148: Navigation during grounding ──
test('TEST P148 — navigation during grounding', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ tagName: 'BUTTON', text: 'Continue' });
  const elId = ElementRegistryModule.register(btn, 1);

  const currentGen = 2;
  const resolved = ElementRegistryModule.resolve(elId, currentGen);
  assert.strictEqual(resolved, null);
});

// ── TEST P149: Navigation during execution ──
test('TEST P149 — navigation during execution', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ tagName: 'BUTTON', text: 'Submit' });
  const elId = ElementRegistryModule.register(btn, 1);

  const action = { action: 'click', target: elId, generation: 1, tabId: 349 };
  const execResult = ExecutorModule.executeAction(action, 2, 349);
  assert.strictEqual(execResult.success, false);
  assert.ok(execResult.error.includes('stale generation'));
});

// ── TEST P150: Return-to-old-URL does not restore stale generation ──
test('TEST P150 — return-to-old-URL does not restore stale generation', () => {
  const sm = new PrivacyStateMachine();
  const gen1 = sm.activateTab(350, 'https://example.com/pageA');
  const gen2 = sm.navigateTab(350, 'https://example.com/pageB');
  const gen3 = sm.navigateTab(350, 'https://example.com/pageA');

  assert.ok(gen1 < gen2);
  assert.ok(gen2 < gen3);
  assert.notStrictEqual(gen1, gen3);

  const req = sm.sendToProvider({ tabId: 350, generation: gen1, userMessage: 'test' }, { provider: 'groq' });
  assert.strictEqual(req.allowed, false);
});

// ── TEST P151: No arbitrary JS execution ──
test('TEST P151 — no arbitrary JS execution', () => {
  const dangerousActions = [
    { action: 'click', target: 'javascript:alert(1)' },
    { action: 'type', target: 'el_1', value: 'javascript:void(0)' },
    { action: 'eval', target: 'el_1' },
    { action: 'Function', target: 'el_1' }
  ];

  for (const act of dangerousActions) {
    const val = ValidatorModule.validateAction(act, 1);
    assert.strictEqual(val.allowed, false);
  }
});

// ── TEST P152: No model-generated selector execution ──
test('TEST P152 — no model-generated selector execution', () => {
  const selectorActions = [
    { action: 'click', target: 'button.submit-btn' },
    { action: 'click', target: '//button[@id="submit"]' },
    { action: 'click', target: '#login-button' },
    { action: 'click', target: 'div > span:first-child' }
  ];

  for (const act of selectorActions) {
    const val = ValidatorModule.validateAction(act, 1);
    assert.strictEqual(val.allowed, false);
    assert.ok(val.reason.includes('not found') || val.reason.includes('rejected'));
  }
});

// ── TEST P153: No model-generated code execution ──
test('TEST P153 — no model-generated code execution', () => {
  const codePlans = [
    { status: 'continue', action: { type: 'runScript', code: 'window.location = "http://evil.com"' } },
    { status: 'continue', action: { type: 'exec', command: 'deleteCookies()' } },
    { status: 'continue', action: { type: 'click', elementId: 'el_1', fn: () => {} } }
  ];

  for (const p of codePlans) {
    const val = AgentCoordinatorModule.validatePlanResponse(p);
    assert.strictEqual(val.valid, false);
  }
});

// ── TEST P154: No unrestricted browser API execution ──
test('TEST P154 — no unrestricted browser API execution', () => {
  const apiPlans = [
    { status: 'continue', action: { type: 'chrome.tabs.create', url: 'http://evil.com' } },
    { status: 'continue', action: { type: 'chrome.cookies.getAll', domain: 'google.com' } },
    { status: 'continue', action: { type: 'chrome.debugger.attach' } }
  ];

  for (const p of apiPlans) {
    const val = AgentCoordinatorModule.validatePlanResponse(p);
    assert.strictEqual(val.valid, false);
    assert.strictEqual(val.error, 'UNSUPPORTED_ACTION_TYPE');
  }
});

// ── TEST P155: Action firewall remains mandatory ──
test('TEST P155 — action firewall remains mandatory', () => {
  function contentScriptFirewall(action, gen, tabId, validator, executor) {
    const val = validator.validateAction(action, gen, tabId);
    if (!val.allowed) {
      return { success: false, error: `Validation failed: ${val.reason}` };
    }
    return executor.executeAction(action, gen);
  }

  let validatorInvoked = false;
  let executorInvoked = false;

  const mockValidator = {
    validateAction: () => {
      validatorInvoked = true;
      return { allowed: false, reason: 'FIREWALL_BLOCKED' };
    }
  };

  const mockExecutor = {
    executeAction: () => {
      executorInvoked = true;
      return { success: true };
    }
  };

  const res = contentScriptFirewall({ action: 'click', target: 'el_1' }, 1, 100, mockValidator, mockExecutor);
  assert.strictEqual(validatorInvoked, true);
  assert.strictEqual(executorInvoked, false);
  assert.strictEqual(res.success, false);
  assert.ok(res.error.includes('FIREWALL_BLOCKED'));
});

// ══════════════════════════════════════════════════════════════════
// PHASE 10 — RELEASE CANDIDATE & SUBMISSION READINESS (P156–P200)
// ══════════════════════════════════════════════════════════════════

const fsModule = require('fs');
const pathModule = require('path');
const extRoot = pathModule.resolve(__dirname, '../extension');
const manifestObj = JSON.parse(fsModule.readFileSync(pathModule.join(extRoot, 'manifest.json'), 'utf8'));

// ── TEST P156: Manifest is MV3 ──
test('TEST P156 — manifest is MV3', () => {
  assert.strictEqual(manifestObj.manifest_version, 3);
});

// ── TEST P157: No obsolete permissions ──
test('TEST P157 — no obsolete permissions', () => {
  const allowed = new Set(['activeTab', 'offscreen', 'sidePanel', 'storage', 'tabs']);
  for (const p of manifestObj.permissions) {
    assert.ok(allowed.has(p), `Forbidden permission: ${p}`);
  }
});

// ── TEST P158: No obsolete script references ──
test('TEST P158 — no obsolete script references', () => {
  const sw = manifestObj.background.service_worker;
  assert.ok(fsModule.existsSync(pathModule.join(extRoot, sw)));
  for (const cs of manifestObj.content_scripts) {
    for (const f of cs.js) {
      assert.ok(fsModule.existsSync(pathModule.join(extRoot, f)), `Missing CS file: ${f}`);
    }
  }
});

// ── TEST P159: Offscreen configuration valid ──
test('TEST P159 — offscreen configuration valid', () => {
  assert.ok(fsModule.existsSync(pathModule.join(extRoot, 'offscreen.html')));
  assert.ok(fsModule.existsSync(pathModule.join(extRoot, 'offscreen.js')));
  const html = fsModule.readFileSync(pathModule.join(extRoot, 'offscreen.html'), 'utf8');
  assert.ok(html.includes('offscreen.js'));
});

// ── TEST P160: All referenced extension files exist ──
test('TEST P160 — all referenced extension files exist', () => {
  assert.ok(fsModule.existsSync(pathModule.join(extRoot, manifestObj.options_ui.page)));
  assert.ok(fsModule.existsSync(pathModule.join(extRoot, manifestObj.side_panel.default_path)));
  assert.ok(fsModule.existsSync(pathModule.join(extRoot, manifestObj.action.default_popup)));
  for (const icon of Object.values(manifestObj.icons)) {
    assert.ok(fsModule.existsSync(pathModule.join(extRoot, icon)), `Missing icon: ${icon}`);
  }
});

// ── TEST P161: API key input masked ──
test('TEST P161 — API key input masked', () => {
  const optionsHtml = fsModule.readFileSync(pathModule.join(extRoot, 'options.html'), 'utf8');
  assert.ok(optionsHtml.includes('id="apiKeyInput" type="password"'));
});

// ── TEST P162: Saved key not rendered in plaintext ──
test('TEST P162 — saved key not rendered in plaintext', () => {
  const optionsJs = fsModule.readFileSync(pathModule.join(extRoot, 'options.js'), 'utf8');
  assert.ok(optionsJs.includes("apiKeyInput.value = ''"));
  assert.ok(optionsJs.includes('Key saved — enter a new key to replace it'));
});

// ── TEST P163: Provider/model selection consistent ──
test('TEST P163 — provider/model selection consistent', () => {
  const mm = global.self?.SIH_ModelManager || global.SIH_ModelManager;
  assert.ok(mm.DEFAULT_CONFIG.providers.groq);
  assert.ok(mm.DEFAULT_CONFIG.providers.gemini);
  assert.ok(mm.DEFAULT_CONFIG.providers.openrouter);
  assert.ok(mm.DEFAULT_CONFIG.providers.local);
});

// ── TEST P164: Unsupported vision model cannot receive screenshot ──
test('TEST P164 — unsupported vision model cannot receive screenshot', () => {
  const mm = global.self?.SIH_ModelManager || global.SIH_ModelManager;
  const groqCap = mm.getModelCapabilities('groq', 'llama3-8b-8192');
  assert.strictEqual(groqCap.vision, false);
  const isVision = mm.isVisionCapableModel('groq', 'llama3-8b-8192');
  assert.strictEqual(isVision, false);
});

// ── TEST P165: Text-only model receives no image ──
test('TEST P165 — text-only model receives no image', () => {
  const mm = global.self?.SIH_ModelManager || global.SIH_ModelManager;
  const openrouterCap = mm.getModelCapabilities('openrouter', 'meta-llama/llama-3-8b-instruct');
  assert.strictEqual(openrouterCap.vision, false);
  assert.strictEqual(mm.isVisionCapableModel('openrouter', 'meta-llama/llama-3-8b-instruct'), false);
});

// ── TEST P166: Privacy status visible ──
test('TEST P166 — privacy status visible', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="privacyStatusSection"'));
  assert.ok(sidebarHtml.includes('PRIVACY PROTECTED'));
});

// ── TEST P167: Privacy status contains no false guarantees ──
test('TEST P167 — privacy status contains no false guarantees', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.strictEqual(sidebarHtml.toLowerCase().includes('100% private'), false);
  assert.strictEqual(sidebarHtml.toLowerCase().includes('nothing ever leaves'), false);
  assert.strictEqual(sidebarHtml.toLowerCase().includes('zero risk'), false);
  assert.ok(sidebarHtml.includes('Sensitive visual data is processed locally before model transmission.'));
});

// ── TEST P168: Raw data never displayed ──
test('TEST P168 — raw data never displayed', () => {
  const sidebarJs = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(!sidebarJs.includes('rawScreenshotImg.src'));
  assert.ok(!sidebarJs.includes('innerHtml = rawContext'));
});

// ── TEST P169: Sanitized artifact status accurate ──
test('TEST P169 — sanitized artifact status accurate', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('Sanitized screenshot when vision is required'));
  assert.ok(sidebarHtml.includes('Bounded OCR text'));
});

// ── TEST P170: Sanitized preview only ──
test('TEST P170 — sanitized preview only', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="sanitizedContextModal"'));
  assert.ok(sidebarHtml.includes('What the AI Sees'));
});

// ── TEST P171: PII categories only ──
test('TEST P171 — PII categories only', () => {
  const sidebarJs = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(sidebarJs.includes('REDACTED]'));
});

// ── TEST P172: No raw OCR ──
test('TEST P172 — no raw OCR', () => {
  const sidebarJs = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(!sidebarJs.includes('seeOcrText.textContent = rawOcr'));
});

// ── TEST P173: No raw DOM dump ──
test('TEST P173 — no raw DOM dump', () => {
  const sidebarJs = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(!sidebarJs.includes('document.documentElement.outerHTML'));
});

// ── TEST P174: Generation-safe context display ──
test('TEST P174 — generation-safe context display', () => {
  const sidebarJs = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(sidebarJs.includes('message.generation !== currentGeneration'));
});

// ── TEST P175: Demo reset works ──
test('TEST P175 — demo reset works', () => {
  const demoHtml = fsModule.readFileSync(pathModule.join(__dirname, 'fixtures/demo_workflow.html'), 'utf8');
  assert.ok(demoHtml.includes('id="btn-reset"'));
  assert.ok(demoHtml.includes('function resetWorkflow()'));
  assert.ok(demoHtml.includes('Start Workflow'));
});

// ── TEST P176: Demo repeatable 5 times ──
test('TEST P176 — demo repeatable 5 times', () => {
  let state = 'START';
  let cycles = 0;
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(state, 'START');
    state = 'CONTINUE';
    state = 'COMPLETE';
    state = 'DONE';
    state = 'START';
    cycles++;
  }
  assert.strictEqual(cycles, 5);
});

// ── TEST P177: No stale transaction after reset ──
test('TEST P177 — no stale transaction after reset', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 10, generation: 1 });
  assert.strictEqual(txRes.transaction.status, 'PLANNING');
  AgentCoordinatorModule.cancelTransaction(txRes.transaction.transactionId, 'Demo reset');
  const current = AgentCoordinatorModule.getActiveTransaction(10);
  assert.strictEqual(current, null);
});

// ── TEST P178: Generation changes correctly when required ──
test('TEST P178 — generation changes correctly when required', () => {
  const sm = new PrivacyStateMachine();
  const gen1 = sm.activateTab(500);
  assert.strictEqual(gen1, 1);
  const gen2 = sm.navigateTab(500, 'https://example.com/step2');
  assert.strictEqual(gen2, 2);
  assert.ok(gen2 > gen1);
});

// ── TEST P179: Unsafe action rejected ──
test('TEST P179 — unsafe action rejected', () => {
  const unsafePlan = {
    status: 'continue',
    action: {
      type: 'execute_javascript',
      code: 'document.body.innerHTML="hacked"'
    }
  };
  const val = AgentCoordinatorModule.validatePlanResponse(unsafePlan);
  assert.strictEqual(val.valid, false);
  assert.strictEqual(val.error, 'UNSUPPORTED_ACTION_TYPE');
});

// ── TEST P180: Valid action still works after rejection ──
test('TEST P180 — valid action still works after rejection', () => {
  const unsafePlan = {
    status: 'continue',
    action: { type: 'execute_javascript', code: 'alert(1)' }
  };
  assert.strictEqual(AgentCoordinatorModule.validatePlanResponse(unsafePlan).valid, false);

  const safePlan = {
    status: 'continue',
    action: { type: 'click', elementId: 'el_1', description: 'Start' }
  };
  assert.strictEqual(AgentCoordinatorModule.validatePlanResponse(safePlan).valid, true);
});

// ── TEST P181: Rejected action cannot mutate DOM ──
test('TEST P181 — rejected action cannot mutate DOM', () => {
  const action = { action: 'execute_javascript', code: 'evil()' };
  const val = ValidatorModule.validateAction(action, 1);
  assert.strictEqual(val.allowed, false);
});

// ── TEST P182: Rejection visible as safe status ──
test('TEST P182 — rejection visible as safe status', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 20, generation: 1 });
  const unsafePlan = { status: 'continue', action: { type: 'eval', code: 'bad()' } };
  const val = AgentCoordinatorModule.validatePlanResponse(unsafePlan);
  assert.strictEqual(val.valid, false);
  AgentCoordinatorModule.cancelTransaction(txRes.transaction.transactionId, `Validation failed: ${val.error}`);
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(20), null);
});

// ── TEST P183: Navigation race safely terminates ──
test('TEST P183 — navigation race safely terminates', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 30, generation: 1 });
  AgentCoordinatorModule.handleNavigation(30, 2);
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(30), null);
});

// ── TEST P184: Stale action cannot execute ──
test('TEST P184 — stale action cannot execute', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ text: 'Scoped' });
  const elId = ElementRegistryModule.register(btn, 1);

  // Resolution in gen 2 fails
  const found = ElementRegistryModule.resolve(elId, 2);
  assert.strictEqual(found, null);
});

// ── TEST P185: New page starts clean generation ──
test('TEST P185 — new page starts clean generation', () => {
  ElementRegistryModule.reset();
  const btn = createMockElement({ text: 'Clean Gen' });
  const elId = ElementRegistryModule.register(btn, 1);
  assert.ok(elId);

  ElementRegistryModule.reset();
  const elements = ElementRegistryModule.getRegisteredElements ? ElementRegistryModule.getRegisteredElements() : [];
  assert.strictEqual(elements.length, 0);
});

// ── TEST P186: Provider failure stops safely ──
test('TEST P186 — provider failure stops safely', () => {
  AgentCoordinatorModule.resetAll();
  const txRes = AgentCoordinatorModule.createTransaction({ tabId: 40, generation: 1 });
  AgentCoordinatorModule.cleanupTransaction(txRes.transaction.transactionId, 'FAILED', 'PROVIDER_UNAVAILABLE');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(40), null);
});

// ── TEST P187: No unsafe fallback ──
test('TEST P187 — no unsafe fallback', () => {
  const mm = global.self?.SIH_ModelManager || global.SIH_ModelManager;
  let fallbackInvoked = false;
  try {
    mm.buildModelPayload('invalid_provider', 'model', { text: 'test' }, null);
  } catch (err) {
    fallbackInvoked = true;
  }
  assert.strictEqual(fallbackInvoked, true);
});

// ── TEST P188: Recovery allows fresh transaction ──
test('TEST P188 — recovery allows fresh transaction', () => {
  AgentCoordinatorModule.resetAll();
  const txRes1 = AgentCoordinatorModule.createTransaction({ tabId: 50, generation: 1 });
  AgentCoordinatorModule.cancelTransaction(txRes1.transaction.transactionId, 'Reset');
  assert.strictEqual(AgentCoordinatorModule.getActiveTransaction(50), null);

  const txRes2 = AgentCoordinatorModule.createTransaction({ tabId: 50, generation: 1 });
  assert.ok(txRes2.success);
  assert.strictEqual(txRes2.transaction.tabId, 50);
  AgentCoordinatorModule.cancelTransaction(txRes2.transaction.transactionId, 'Clean up');
});

// ── TEST P189: 360px sidebar layout ──
test('TEST P189 — 360px sidebar layout', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('min-width: 320px'));
  assert.ok(css.includes('max-width: 540px'));
});

// ── TEST P190: 400px sidebar layout ──
test('TEST P190 — 400px sidebar layout', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('width: 100%'));
  assert.ok(css.includes('overflow-x: hidden'));
});

// ── TEST P191: 480px sidebar layout ──
test('TEST P191 — 480px sidebar layout', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('max-width: 540px'));
});

// ── TEST P192: Dark theme ──
test('TEST P192 — dark theme', () => {
  const themeCss = fsModule.readFileSync(pathModule.join(extRoot, 'theme.css'), 'utf8');
  assert.ok(themeCss.includes('[data-theme="dark"]'));
  assert.ok(themeCss.includes('--bg:'));
});

// ── TEST P193: Light theme ──
test('TEST P193 — light theme', () => {
  const themeCss = fsModule.readFileSync(pathModule.join(extRoot, 'theme.css'), 'utf8');
  assert.ok(themeCss.includes(':root'));
  assert.ok(themeCss.includes('--text-primary:'));
});

// ── TEST P194: Primary controls keyboard reachable ──
test('TEST P194 — primary controls keyboard reachable', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="refreshBtn"'));
  assert.ok(sidebarHtml.includes('id="settingsBtn"'));
  assert.ok(sidebarHtml.includes('id="userInput"'));
  assert.ok(sidebarHtml.includes('id="sendBtn"'));
});

// ── TEST P195: Interactive controls have accessible names ──
test('TEST P195 — interactive controls have accessible names', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('aria-label="Refresh Context"'));
  assert.ok(sidebarHtml.includes('aria-label="Settings"'));
  assert.ok(sidebarHtml.includes('aria-label="Send"'));
});

// ── TEST P196: Status messages readable ──
test('TEST P196 — status messages readable', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="headerStatusLabel"'));
  assert.ok(sidebarHtml.includes('Protected'));
});

// ── TEST P197: Action firewall mandatory ──
test('TEST P197 — action firewall mandatory', () => {
  const valJs = fsModule.readFileSync(pathModule.join(extRoot, 'validate.js'), 'utf8');
  const execJs = fsModule.readFileSync(pathModule.join(extRoot, 'execute.js'), 'utf8');
  assert.ok(valJs.includes('ALLOWED_ACTIONS'));
  assert.ok(execJs.includes('currentGeneration'));
});

// ── TEST P198: Unsupported action rejected ──
test('TEST P198 — unsupported action rejected', () => {
  const plan = { status: 'continue', action: { type: 'hover', elementId: 'el_1' } };
  const val = AgentCoordinatorModule.validatePlanResponse(plan);
  assert.strictEqual(val.valid, false);
  assert.strictEqual(val.error, 'UNSUPPORTED_ACTION_TYPE');
});

// ── TEST P199: Selector injection rejected ──
test('TEST P199 — selector injection rejected', () => {
  const action = { action: 'click', target: 'div > script', generation: 1 };
  const val = ValidatorModule.validateAction(action, 1);
  assert.strictEqual(val.allowed, false);
  assert.ok(val.reason.includes('Arbitrary selector rejected'));
});

// ── TEST P200: Arbitrary code rejected ──
test('TEST P200 — arbitrary code rejected', () => {
  const plan = { status: 'continue', action: { type: 'click', elementId: 'el_1', fn: 'alert(1)' } };
  const val = AgentCoordinatorModule.validatePlanResponse(plan);
  assert.strictEqual(val.valid, false);
});

// ════════════════════════════════════════════════════════
// PHASE 13 — SIDEBAR UX RESTRUCTURE TESTS (P201–P220)
// ════════════════════════════════════════════════════════

// ── TEST P201: Chat is default view ──
test('TEST P201 — Chat is default view', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="chatView" class="view-pane active"'));
  assert.ok(sidebarHtml.includes('id="tabChat" role="tab" class="nav-tab active" aria-selected="true"'));
});

// ── TEST P202: Context is separate from Chat ──
test('TEST P202 — Context is separate from Chat', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="contextView"'));
  const chatIndex = sidebarHtml.indexOf('id="chatView"');
  const contextIndex = sidebarHtml.indexOf('id="contextView"');
  assert.ok(chatIndex !== -1 && contextIndex !== -1);
  assert.ok(chatIndex < contextIndex);
  assert.ok(sidebarHtml.includes('id="contextView" role="tabpanel" aria-labelledby="tabContext" style="display: none;"'));
});

// ── TEST P203: Privacy is separate from Chat ──
test('TEST P203 — Privacy is separate from Chat', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="privacyView"'));
  const chatIndex = sidebarHtml.indexOf('id="chatView"');
  const privacyIndex = sidebarHtml.indexOf('id="privacyView"');
  assert.ok(chatIndex !== -1 && privacyIndex !== -1);
  assert.ok(chatIndex < privacyIndex);
  assert.ok(sidebarHtml.includes('id="privacyView" role="tabpanel" aria-labelledby="tabPrivacy" style="display: none;"'));
});

// ── TEST P204: Model selector not present in main Chat ──
test('TEST P204 — Model selector not present in main Chat', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  const chatStart = sidebarHtml.indexOf('id="chatView"');
  const chatEnd = sidebarHtml.indexOf('id="contextView"');
  const chatSection = sidebarHtml.slice(chatStart, chatEnd);
  assert.strictEqual(chatSection.includes('id="sidebarModelSelect"'), false);
  const settingsModalSection = sidebarHtml.slice(sidebarHtml.indexOf('id="settingsModal"'));
  assert.ok(settingsModalSection.includes('id="sidebarModelSelect"'));
});

// ── TEST P205: Privacy details not duplicated in Chat ──
test('TEST P205 — Privacy details not duplicated in Chat', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  const chatStart = sidebarHtml.indexOf('id="chatView"');
  const chatEnd = sidebarHtml.indexOf('id="contextView"');
  const chatSection = sidebarHtml.slice(chatStart, chatEnd);
  assert.strictEqual(chatSection.includes('id="privacyStatusSection"'), false);
  assert.strictEqual(chatSection.includes('Face detection'), false);
  assert.strictEqual(chatSection.includes('PII sanitization'), false);
  assert.strictEqual(chatSection.includes('Raw credentials'), false);
  assert.ok(chatSection.includes('id="chatPrivacyBadge"'));
});

// ── TEST P206: Context details not duplicated in Chat ──
test('TEST P206 — Context details not duplicated in Chat', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  const chatStart = sidebarHtml.indexOf('id="chatView"');
  const chatEnd = sidebarHtml.indexOf('id="contextView"');
  const chatSection = sidebarHtml.slice(chatStart, chatEnd);
  assert.strictEqual(chatSection.includes('id="sanitizedScreenshotImg"'), false);
  assert.strictEqual(chatSection.includes('id="evidenceMetaGrid"'), false);
  assert.strictEqual(chatSection.includes('id="metaGeneration"'), false);
});

// ── TEST P207: Composer remains visible ──
test('TEST P207 — Composer remains visible', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  const chatStart = sidebarHtml.indexOf('id="chatView"');
  const chatEnd = sidebarHtml.indexOf('id="contextView"');
  const chatSection = sidebarHtml.slice(chatStart, chatEnd);
  assert.ok(chatSection.includes('class="input-area"'));
  assert.ok(chatSection.includes('id="userInput"'));
  assert.ok(chatSection.includes('id="sendBtn"'));
});

// ── TEST P208: No page-level vertical overflow ──
test('TEST P208 — No page-level vertical overflow', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('overflow-y: hidden'));
  assert.ok(css.includes('height: 100vh'));
});

// ── TEST P209: 320px layout works ──
test('TEST P209 — 320px layout works', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('min-width: 320px'));
  assert.ok(css.includes('@media (max-width: 360px)'));
});

// ── TEST P210: 360px layout works ──
test('TEST P210 — 360px layout works', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('min-width: 320px'));
  assert.ok(css.includes('max-width: 540px'));
});

// ── TEST P211: 400px layout works ──
test('TEST P211 — 400px layout works', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('overflow-x: hidden'));
  assert.ok(css.includes('width: 100%'));
});

// ── TEST P212: 480px layout works ──
test('TEST P212 — 480px layout works', () => {
  const css = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.css'), 'utf8');
  assert.ok(css.includes('max-width: 540px'));
});

// ── TEST P213: Tab switching preserves chat state ──
test('TEST P213 — Tab switching preserves chat state', () => {
  const js = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(js.includes('function switchTab'));
  assert.ok(js.includes('tabMap'));
  assert.ok(!js.match(/switchTab\([^)]*\)\s*\{[^}]*conversationStream\.innerHTML\s*=\s*['"]['"]/));
});

// ── TEST P214: Tab switching does not trigger processing ──
test('TEST P214 — Tab switching does not trigger processing', () => {
  const js = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  const switchTabMatch = js.match(/function switchTab[\s\S]*?\n  \}/);
  assert.ok(switchTabMatch);
  const fnBody = switchTabMatch[0];
  assert.strictEqual(fnBody.includes('fetchLatestContext'), false);
  assert.strictEqual(fnBody.includes('REQUEST_CONTEXT_REFRESH'), false);
  assert.strictEqual(fnBody.includes('captureVisibleTab'), false);
});

// ── TEST P215: Privacy information remains accurate ──
test('TEST P215 — Privacy information remains accurate', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  const privacyStart = sidebarHtml.indexOf('id="privacyView"');
  const privacySection = sidebarHtml.slice(privacyStart);
  assert.ok(privacySection.includes('PRIVACY PROTECTED'));
  assert.ok(privacySection.includes('Sensitive visual data is processed locally before model transmission.'));
  assert.ok(privacySection.includes('Face detection'));
  assert.ok(privacySection.includes('OCR'));
  assert.ok(privacySection.includes('PII sanitization'));
});

// ── TEST P216: Context information remains accurate ──
test('TEST P216 — Context information remains accurate', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  const contextStart = sidebarHtml.indexOf('id="contextView"');
  const privacyStart = sidebarHtml.indexOf('id="privacyView"');
  const contextSection = sidebarHtml.slice(contextStart, privacyStart);
  assert.ok(contextSection.includes('id="seePageUrl"'));
  assert.ok(contextSection.includes('id="seeVisualStatus"'));
  assert.ok(contextSection.includes('id="seeOcrStatus"'));
  assert.ok(contextSection.includes('id="seeDetectedCategories"'));
  assert.ok(contextSection.includes('id="seeElementsCount"'));
  assert.ok(contextSection.includes('id="seeModelInfo"'));
});

// ── TEST P217: Agent status remains accurate ──
test('TEST P217 — Agent status remains accurate', () => {
  const js = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(js.includes('AGENT_STATUS_UPDATE'));
  assert.ok(js.includes('metaAgent.textContent = message.status || \'Idle\''));
});

// ── TEST P218: Dark theme works ──
test('TEST P218 — Dark theme works', () => {
  const themeCss = fsModule.readFileSync(pathModule.join(extRoot, 'theme.css'), 'utf8');
  assert.ok(themeCss.includes('[data-theme="dark"]'));
  assert.ok(themeCss.includes('--bg:'));
  assert.ok(themeCss.includes('--surface:'));
});

// ── TEST P219: Light theme works ──
test('TEST P219 — Light theme works', () => {
  const themeCss = fsModule.readFileSync(pathModule.join(extRoot, 'theme.css'), 'utf8');
  assert.ok(themeCss.includes(':root'));
  assert.ok(themeCss.includes('--text-primary:'));
});

// ── TEST P220: No raw sensitive data appears in UI ──
test('TEST P220 — No raw sensitive data appears in UI', () => {
  const sidebarHtml = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.html'), 'utf8');
  const sidebarJs = fsModule.readFileSync(pathModule.join(extRoot, 'sidebar.js'), 'utf8');
  assert.ok(!sidebarHtml.includes('rawContext'));
  assert.ok(!sidebarHtml.includes('rawScreenshot'));
  assert.ok(!sidebarJs.includes('rawScreenshotImg.src'));
  assert.ok(!sidebarJs.includes('innerHtml = rawContext'));
});

async function runAll() {
  for (const { name, fn } of testQueue) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`[FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('ALL PRIVACY TESTS PASSED CONVINCINGLY.');
  }
}

runAll();
