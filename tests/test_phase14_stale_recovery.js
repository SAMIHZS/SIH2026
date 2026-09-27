const puppeteer = require('e:/SIH2026/node_modules/puppeteer');
const path = require('path');
const http = require('http');
const assert = require('assert');

(async () => {
  console.log('===============================================================');
  console.log('PHASE 14 — REAL CHROME SURGICAL STALE-ELEMENT RECOVERY TEST');
  console.log('===============================================================');

  // 1. Local test HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Phase 14 Stale Element Recovery</title></head>
<body style="font-family: Arial, sans-serif; padding: 24px;">
  <h1>User Profile</h1>
  <div id="profileContainer">
    <button id="btnA" style="padding: 10px 20px; font-size: 16px;" onclick="window.__clickedA = true;">LinkedIn</button>
  </div>
  <script>
    window.__clickedA = false;
    window.__clickedB = false;
  </script>
</body>
</html>`);
  });

  const TEST_PORT = 8999;
  await new Promise(resolve => server.listen(TEST_PORT, '127.0.0.1', resolve));
  console.log(`Local test server listening on http://127.0.0.1:${TEST_PORT}`);

  const extensionPath = path.resolve('E:/SIH2026/extension');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  const swLogs = [];
  let base64Leaks = 0;
  let keyLeaks = 0;

  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 10000 });
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
    });

    const extId = new URL(serviceWorker.url()).hostname;
    console.log(`[PASS] Extension SW connected. Extension ID: ${extId}`);

    // Open Profile Page
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${TEST_PORT}/`, { waitUntil: 'networkidle0' });

    // Wait for content script handshake & perception
    await new Promise(r => setTimeout(r, 1200));

    const tabInfo = await serviceWorker.evaluate(() => {
      const s = tabPerceptionState.get(activeTabId);
      return { tabId: activeTabId, generation: s ? s.generation : 1 };
    });

    console.log('\n--- Step 1 & 2: Active Tab Info & Observation ---', tabInfo);

    // Query grounded inventory
    const initialInv = await serviceWorker.evaluate(async (tInfo) => {
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tInfo.tabId, { type: 'QUERY_GROUNDING', query: 'inventory', generation: tInfo.generation, tabId: tInfo.tabId }, resolve);
      });
    }, tabInfo);

    assert.ok(initialInv && initialInv.ok && initialInv.inventory.length > 0, 'Initial inventory should contain elements');
    const elementAEntry = initialInv.inventory.find(el => el.text.includes('LinkedIn'));
    assert.ok(elementAEntry, 'Element A ("LinkedIn") must be observed');
    const elementAId = elementAEntry.elementId;
    console.log(`[PASS] Step 1 & 2: Element A observed and registered as ${elementAId}`);

    // Step 3 & 4: DOM replaces Element A with Element B while same generation remains active
    console.log('\n--- Step 3 & 4: DOM replaces Element A with Element B (Same Generation) ---');
    await page.evaluate(() => {
      const container = document.getElementById('profileContainer');
      const oldBtn = document.getElementById('btnA');
      oldBtn.remove(); // Element A is disconnected

      const newBtn = document.createElement('button');
      newBtn.id = 'btnB';
      newBtn.style.padding = '10px 20px';
      newBtn.style.fontSize = '16px';
      newBtn.innerText = 'LinkedIn';
      newBtn.onclick = () => {
        window.__clickedB = true;
      };
      container.appendChild(newBtn);
    });

    const domCheck = await page.evaluate(() => ({
      hasBtnA: !!document.getElementById('btnA'),
      hasBtnB: !!document.getElementById('btnB'),
      btnBConnected: document.getElementById('btnB')?.isConnected
    }));
    console.log('DOM state after replacement:', domCheck);
    assert.strictEqual(domCheck.hasBtnA, false, 'Element A must be removed from DOM');
    assert.strictEqual(domCheck.hasBtnB, true, 'Element B must exist in DOM');

    // Step 5-6: Attempt to execute old elementId -> safely rejected as stale
    console.log('\n--- Step 5-6: Execute Old elementId -> Stale Detected & Rejected ---');
    const executeResponse = await serviceWorker.evaluate(async (tInfo, oldTargetId) => {
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tInfo.tabId, {
          type: 'EXECUTE_ACTION',
          actionPayload: {
            action: 'click',
            target: oldTargetId,
            text: 'LinkedIn',
            generation: tInfo.generation,
            tabId: tInfo.tabId
          },
          tabId: tInfo.tabId
        }, resolve);
      });
    }, tabInfo, elementAId);

    console.log('Execution Response (Old Target):', executeResponse);
    assert.strictEqual(executeResponse.success, false, 'Old disconnected element must be rejected');
    assert.ok(executeResponse.error.includes('STALE_OR_UNKNOWN_ELEMENT') || executeResponse.error.includes('UNKNOWN_OR_DISCONNECTED_TARGET'), 'Error must indicate stale/unknown element');

    // Step 7-10: Fresh Grounding on Current DOM -> Safe Execution on Element B
    console.log('\n--- Step 7-10: Fresh Grounding on Current DOM -> Safe Execution on Element B ---');
    const freshInv = await serviceWorker.evaluate(async (tInfo) => {
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tInfo.tabId, { type: 'QUERY_GROUNDING', query: 'inventory', generation: tInfo.generation, tabId: tInfo.tabId }, resolve);
      });
    }, tabInfo);

    const elementBEntry = freshInv.inventory.find(el => el.text.includes('LinkedIn'));
    assert.ok(elementBEntry, 'Element B ("LinkedIn") must be observed in fresh inventory');
    const elementBId = elementBEntry.elementId;
    console.log(`[PASS] Element B observed as ${elementBId}`);

    const executeResponseB = await serviceWorker.evaluate(async (tInfo, newTargetId) => {
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tInfo.tabId, {
          type: 'EXECUTE_ACTION',
          actionPayload: {
            action: 'click',
            target: newTargetId,
            text: 'LinkedIn',
            generation: tInfo.generation,
            tabId: tInfo.tabId
          },
          tabId: tInfo.tabId
        }, resolve);
      });
    }, tabInfo, elementBId);

    console.log('Execution Response (Element B):', executeResponseB);
    assert.ok(executeResponseB && executeResponseB.success, 'Action execution on Element B must succeed');

    // Verify Element A was NOT clicked and Element B WAS clicked
    const clickResults = await page.evaluate(() => ({
      clickedA: window.__clickedA,
      clickedB: window.__clickedB
    }));

    console.log('\n--- Verification ---');
    console.log('Element A clicked:', clickResults.clickedA);
    console.log('Element B clicked:', clickResults.clickedB);

    assert.strictEqual(clickResults.clickedA, false, 'Element A must NOT have been clicked');
    assert.strictEqual(clickResults.clickedB, true, 'Element B must have been clicked');

    console.log('[PASS] Element A: NOT clicked');
    console.log('[PASS] Element B: clicked');

    // Leak audit
    assert.strictEqual(base64Leaks, 0, 'Zero base64 screenshot leaks');
    assert.strictEqual(keyLeaks, 0, 'Zero API key leaks');

    console.log('\n===============================================================');
    console.log('ALL PHASE 14 REAL CHROME STALE RECOVERY VERIFICATIONS PASSED 100%');
    console.log('===============================================================');
  } finally {
    await browser.close();
    server.close();
  }
})();
