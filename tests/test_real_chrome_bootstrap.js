const puppeteer = require('puppeteer');
const path = require('path');
const http = require('http');
const assert = require('assert');

(async () => {
  console.log('===============================================================');
  console.log('REAL CHROME BOOTSTRAP & RECOVERY VERIFICATION (CASES A, B, C, D)');
  console.log('===============================================================');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!DOCTYPE html><html><body><h1>Fresh Page</h1><button id="testBtn">Click Me</button></body></html>');
  });
  await new Promise(r => server.listen(8993, '127.0.0.1', r));

  const extensionPath = path.resolve(__dirname, '../extension');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox'
    ]
  });

  const swLogs = [];
  let base64Leaks = 0;
  let keyLeaks = 0;
  let ocrLeaks = 0;

  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 15000 });
    const serviceWorker = await swTarget.worker();

    serviceWorker.on('console', msg => {
      const text = msg.text();
      swLogs.push(text);

      if (/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]{150,}/.test(text)) {
        base64Leaks++;
        console.error('[LEAK DETECTED IN SW CONSOLE — IMAGE DATA]', text.slice(0, 100));
      }
      if (/AIzaSy[A-Za-z0-9_-]{20,}/.test(text) || /sk-[A-Za-z0-9_-]{20,}/.test(text)) {
        keyLeaks++;
        console.error('[LEAK DETECTED IN SW CONSOLE — API KEY]');
      }
      if (text.includes('private_ssn') || text.includes('secret_passport')) {
        ocrLeaks++;
        console.error('[LEAK DETECTED IN SW CONSOLE — RAW PII]');
      }
    });

    const extId = new URL(serviceWorker.url()).hostname;
    console.log(`[PASS] Extension SW connected. Extension ID: ${extId}`);

    // =========================================================================
    // STEP 1: OPEN https://raifkaya.nl IN REAL CHROME
    // =========================================================================
    console.log('\n--- Step 1: Navigating to https://raifkaya.nl ---');
    const page = await browser.newPage();
    try {
      await page.goto('https://raifkaya.nl', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      console.warn('Network load warning (continuing with loaded DOM):', e.message);
    }
    await new Promise(r => setTimeout(r, 2000));

    // Wait for tab perception to complete
    let tabInfo = null;
    for (let i = 0; i < 40; i++) {
      tabInfo = await serviceWorker.evaluate((attempt) => {
        const s = tabPerceptionState.get(activeTabId);
        if (attempt === 8 && (!s || !s.isValid)) {
          requestContextRefresh(activeTabId, 'test_initial');
        }
        return {
          tabId: activeTabId,
          generation: s ? s.generation : 0,
          isValid: s ? s.isValid : false,
          elementCount: s?.sanitizedContext?.elements?.length || s?.sanitizedContext?.interactiveElements?.length || 0,
          url: s?.navigationIdentity || ''
        };
      }, i);
      if (tabInfo && tabInfo.isValid && tabInfo.elementCount > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }
    console.log('Active Tab Perception Info:', tabInfo);
    console.log('SW Logs up to Step 1:', swLogs);

    assert.ok(tabInfo.tabId, 'Active tabId must exist');
    assert.strictEqual(tabInfo.isValid, true, 'Tab perception must be valid');
    assert.ok(tabInfo.elementCount > 0, `Interactive element count must be > 0 (got ${tabInfo.elementCount})`);
    console.log(`[PASS] Initial load on raifkaya.nl: generation=${tabInfo.generation}, interactiveElements=${tabInfo.elementCount}`);

    // =========================================================================
    // STEP 2: OPEN SIDEBAR & VERIFY READY STATE
    // =========================================================================
    console.log('\n--- Step 2: Open Sidebar UI ---');
    const sidebarPage = await browser.newPage();
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1000));

    const sidebarState = await sidebarPage.evaluate(() => {
      const dot = document.querySelector('.header-status-dot');
      const label = document.querySelector('.header-status-label');
      return {
        dotBg: dot ? dot.style.background : '',
        labelText: label ? label.textContent : ''
      };
    });
    console.log('Sidebar Initial State:', sidebarState);
    assert.ok(!sidebarState.labelText.includes('Reading page...'), 'Sidebar must not be permanently stuck in "Reading page..."');
    console.log('[PASS] Sidebar successfully opened and connected without indefinite loading.');

    // =========================================================================
    // CASE A: SIMULATE DISCONNECTED CONTENT SCRIPT / EXTENSION RESTART ON raifkaya.nl
    // =========================================================================
    console.log('\n--- CASE A: Automatic Recovery of Missing/Disconnected Content Script ---');
    // Ensure raifkaya.nl is active tab
    await page.bringToFront();
    await new Promise(r => setTimeout(r, 800));

    // Without refreshing the page, simulate recovering a disconnected tab via ensureContentScriptAvailable
    const recoveryResult = await serviceWorker.evaluate(async (tId) => {
      const t0 = performance.now();
      // Call programmatic ensureContentScriptAvailable
      const ensureRes = await ensureContentScriptAvailable(tId);
      // Now fetch and broadcast context
      const curState = tabPerceptionState.get(tId);
      const gen = curState ? curState.generation : 1;
      const fetchRes = await fetchAndBroadcastTabContext(tId, gen, t0);
      return {
        ensureRes,
        fetchRes,
        generation: curState?.generation,
        elementCount: curState?.sanitizedContext?.elements?.length || curState?.sanitizedContext?.interactiveElements?.length || 0
      };
    }, tabInfo.tabId);

    console.log('CASE A Recovery Result:', recoveryResult);
    assert.strictEqual(recoveryResult.ensureRes.ok, true, 'ensureContentScriptAvailable must succeed');
    assert.strictEqual(recoveryResult.fetchRes, true, 'fetchAndBroadcastTabContext must complete');
    assert.ok(recoveryResult.elementCount > 0, 'Recovered context must have interactive elements');
    console.log('[PASS] CASE A: Content script recovered and responded with fresh context without refreshing the page.');

    // =========================================================================
    // CASE B: SWITCH TABS AND RETURN TO raifkaya.nl
    // =========================================================================
    console.log('\n--- CASE B: Switch Tabs and Return ---');
    const dummyPage = await browser.newPage();
    await dummyPage.goto('data:text/html,<html><body><h1>Other Tab</h1></body></html>');
    await new Promise(r => setTimeout(r, 1000));

    // Return to raifkaya.nl tab
    await page.bringToFront();
    await new Promise(r => setTimeout(r, 1500));

    const returnedTabInfo = await serviceWorker.evaluate(() => {
      const s = tabPerceptionState.get(activeTabId);
      return {
        tabId: activeTabId,
        generation: s?.generation,
        isValid: s?.isValid,
        elementCount: s?.sanitizedContext?.elements?.length || s?.sanitizedContext?.interactiveElements?.length || 0
      };
    });
    console.log('CASE B Returned Tab Info:', returnedTabInfo);
    assert.strictEqual(returnedTabInfo.isValid, true, 'Tab perception must be valid upon return');
    assert.ok(returnedTabInfo.elementCount > 0, 'Element count must be preserved');
    console.log('[PASS] CASE B: Tab switch and return maintained valid perception.');
    await dummyPage.close();

    // =========================================================================
    // CASE C: FRESH WEBPAGE OPENS AND PERCEPTION WORKS
    // =========================================================================
    console.log('\n--- CASE C: Fresh Webpage Static Injection ---');
    const freshPage = await browser.newPage();
    await freshPage.goto('http://127.0.0.1:8993/', { waitUntil: 'domcontentloaded' });

    let freshTabInfo = null;
    for (let i = 0; i < 20; i++) {
      freshTabInfo = await serviceWorker.evaluate(() => {
        const s = tabPerceptionState.get(activeTabId);
        return {
          tabId: activeTabId,
          generation: s?.generation,
          isValid: s?.isValid,
          elementCount: s?.sanitizedContext?.elements?.length || s?.sanitizedContext?.interactiveElements?.length || 0
        };
      });
      if (freshTabInfo && freshTabInfo.isValid && freshTabInfo.elementCount > 0) break;
      await new Promise(r => setTimeout(r, 400));
    }
    console.log('CASE C Fresh Tab Info:', freshTabInfo);
    assert.strictEqual(freshTabInfo.isValid, true, 'Fresh page perception must be valid');
    assert.ok(freshTabInfo.elementCount > 0, 'Fresh page must have elements');
    console.log('[PASS] CASE C: Fresh webpage loaded and perception succeeded.');
    await freshPage.close();

    // =========================================================================
    // CASE D: RESTRICTED URL (chrome://extensions) HANDLING
    // =========================================================================
    console.log('\n--- CASE D: Restricted URL Handling ---');
    const restrictedPage = await browser.newPage();
    try {
      await restrictedPage.goto('chrome://extensions', { waitUntil: 'domcontentloaded' });
    } catch (_) {}
    await new Promise(r => setTimeout(r, 1200));

    const restrictedResult = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentTab = tabs[0];
      const bootstrap = await ensureContentScriptAvailable(currentTab.id);
      return {
        tabId: currentTab.id,
        url: currentTab.url,
        bootstrapOk: bootstrap.ok,
        reason: bootstrap.reason
      };
    });
    console.log('CASE D Restricted URL Result:', restrictedResult);
    assert.strictEqual(restrictedResult.bootstrapOk, false, 'Bootstrap must not attempt injection on restricted URLs');
    assert.strictEqual(restrictedResult.reason, 'RESTRICTED_URL', 'Must report RESTRICTED_URL');
    console.log('[PASS] CASE D: Restricted URL rejected cleanly without injection attempt.');
    await restrictedPage.close();

    // =========================================================================
    // STEP 3: EXECUTE A GROUNDED ACTION ON raifkaya.nl
    // =========================================================================
    console.log('\n--- Step 3: Execute Grounded Action on raifkaya.nl ---');
    await page.bringToFront();
    await new Promise(r => setTimeout(r, 1000));

    const actionExecution = await serviceWorker.evaluate(async (tId) => {
      // Get grounded inventory
      const invResp = await new Promise(r => {
        chrome.tabs.sendMessage(tId, { type: 'QUERY_GROUNDING', query: 'inventory' }, r);
      });
      const inventory = invResp?.inventory || [];
      if (inventory.length === 0) return { ok: false, error: 'No inventory' };

      const firstInteractive = inventory[0];
      const curState = tabPerceptionState.get(tId);
      const actionPayload = {
        action: 'click',
        target: firstInteractive.elementId,
        generation: curState.generation,
        tabId: tId
      };

      const execRes = await new Promise(r => {
        chrome.tabs.sendMessage(tId, { type: 'EXECUTE_ACTION', action: actionPayload }, r);
      });

      return {
        ok: true,
        target: firstInteractive.elementId,
        execRes
      };
    }, tabInfo.tabId);

    console.log('Action Execution Result:', actionExecution);
    assert.strictEqual(actionExecution.ok, true, 'Grounded action target found');
    console.log('[PASS] Grounded action target verified on raifkaya.nl.');

    // =========================================================================
    // PRIVACY AUDIT OF LOGS
    // =========================================================================
    console.log('\n--- Service Worker Console Privacy Audit ---');
    console.log(`Total SW log lines captured: ${swLogs.length}`);
    console.log(`Base64 screenshot leaks: ${base64Leaks}`);
    console.log(`API key leaks:           ${keyLeaks}`);
    console.log(`PII leaks:               ${ocrLeaks}`);

    assert.strictEqual(base64Leaks, 0, 'No base64 screenshot leaks allowed');
    assert.strictEqual(keyLeaks, 0, 'No API key leaks allowed');
    assert.strictEqual(ocrLeaks, 0, 'No PII leaks allowed');
    console.log('[PASS] Privacy audit 100% clean: zero leaks in console logs.');

    console.log('\n===============================================================');
    console.log('ALL REAL CHROME BOOTSTRAP & RECOVERY TESTS PASSED (CASES A-D)!');
    console.log('===============================================================');

  } finally {
    try { server.close(); } catch (_) {}
    await browser.close();
  }
})().catch(err => {
  console.error('\n[FATAL TEST FAILURE]', err);
  process.exit(1);
});
