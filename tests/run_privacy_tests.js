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

// ── Test harness ──
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
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
    const prevTabId = this.activeTabId;
    this.activeTabId = tabId;

    if (prevTabId && prevTabId !== tabId) {
      this.invalidateTab(prevTabId, 'tab_deactivated');
    }

    return this.invalidateTab(tabId, 'tab_activated', url);
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
    currentTabState.screenshot = screenshot || null;
    currentTabState.isValid = true;
    return { ok: true, discarded: false };
  }

  // Provider Payload Gate
  sendToProvider(request) {
    const { tabId, generation, navigationIdentity, userMessage, sanitizedContext } = request;
    const activeState = this.tabPerceptionState.get(this.activeTabId);

    const failClosed = (reason) => {
      return {
        allowed: false,
        error: 'CONTEXT_INVALIDATED',
        message: 'Page context changed. Please retry.',
        reason
      };
    };

    if (!this.activeTabId || !activeState) {
      return failClosed('No active tab state found');
    }
    if (tabId !== this.activeTabId) {
      return failClosed(`Request tab (${tabId}) does not match active tab (${this.activeTabId})`);
    }
    if (generation !== undefined && generation !== activeState.generation) {
      return failClosed(`Request generation (${generation}) does not match active generation (${activeState.generation})`);
    }
    if (navigationIdentity && activeState.navigationIdentity && navigationIdentity !== activeState.navigationIdentity) {
      return failClosed('Navigation identity mismatch');
    }
    const ctx = sanitizedContext || activeState.sanitizedContext;
    if (!ctx || !activeState.isValid) {
      return failClosed('No valid sanitized context');
    }
    if (ctx.screenshot) {
      if (typeof ctx.screenshot !== 'string' || !ctx.screenshot.startsWith('data:image/')) {
        return failClosed('Screenshot is not a valid local data URL');
      }
      if (!activeState.screenshot || activeState.screenshot !== ctx.screenshot) {
        return failClosed('Screenshot data does not match active page generation');
      }
    }

    // Passed gate!
    this.remoteTransmissions.push({
      tabId,
      generation,
      navigationIdentity,
      hasScreenshot: Boolean(ctx.screenshot),
      screenshotData: ctx.screenshot || null
    });

    return {
      allowed: true,
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

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('ALL PRIVACY TESTS PASSED CONVINCINGLY.');
}
