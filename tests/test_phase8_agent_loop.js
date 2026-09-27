const puppeteer = require('e:/SIH2026/node_modules/puppeteer');
const path = require('path');
const http = require('http');

(async () => {
  console.log('===============================================================');
  console.log('PHASE 8 — REAL CHROME MULTI-STEP AGENT PLANNING & TRANSACTIONS');
  console.log('===============================================================');

  // 1. Local test HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url === '/pageB') {
      res.end(`<!DOCTYPE html>
<html>
<head><title>Page B Navigation Target</title></head>
<body>
  <h1>Navigation Target Page</h1>
</body>
</html>`);
    } else {
      res.end(`<!DOCTYPE html>
<html>
<head><title>Phase 8 Agent Workflow</title></head>
<body style="font-family: Arial, sans-serif; padding: 24px;">
  <h1>SIH Agent Multi-Step Workflow Test</h1>
  <p>Perform the sequential workflow steps.</p>

  <div id="container" style="margin-top: 20px;">
    <button id="btn-start" style="padding: 10px 20px; font-size: 16px;" onclick="onStartClicked()">Start Workflow</button>
  </div>

  <div id="dup-container" style="margin-top: 30px;">
    <button class="dup-btn" style="padding: 6px 12px;">Duplicate Button</button>
    <button class="dup-btn" style="padding: 6px 12px; margin-left: 10px;">Duplicate Button</button>
  </div>

  <script>
    function onStartClicked() {
      document.getElementById('container').innerHTML = '<button id="btn-continue" style="padding: 10px 20px; font-size: 16px;" onclick="onContinueClicked()">Continue Workflow</button>';
      window.__step1Completed = true;
    }
    function onContinueClicked() {
      document.getElementById('container').innerHTML = '<div id="success" style="font-weight: bold; color: green; font-size: 18px;">Workflow Complete</div>';
      window.__step2Completed = true;
    }
  </script>
</body>
</html>`);
    }
  });

  await new Promise(resolve => server.listen(8996, '127.0.0.1', resolve));
  console.log('Local test server listening on http://127.0.0.1:8996');

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
  let ocrTextLeaks = 0;

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
      if (text.includes('Perform the sequential workflow') || text.includes('Workflow Complete')) {
        ocrTextLeaks++;
        console.error('[LEAK DETECTED IN SW CONSOLE — RAW OCR TEXT]', text.slice(0, 80));
      }
    });

    const extId = new URL(serviceWorker.url()).hostname;
    console.log(`[PASS] Extension SW connected. Extension ID: ${extId}`);

    // Open target page
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8996/', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 1200));

    const tabInfo = await serviceWorker.evaluate(() => {
      const s = tabPerceptionState.get(activeTabId);
      return { tabId: activeTabId, generation: s ? s.generation : 1 };
    });
    console.log('\n--- Active Tab Info for Agent Loop ---', tabInfo);

    // =========================================================================
    // TEST 1: SEQUENTIAL MULTI-STEP AGENT WORKFLOW (Start -> Continue -> Complete)
    // =========================================================================
    console.log('\n--- TEST 1: Multi-Step Sequential Workflow Execution ---');
    const perfMetrics = {};

    const workflowResult = await serviceWorker.evaluate(async (tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();

      const txRes = coordinator.createTransaction({
        tabId: tId,
        generation: gen,
        goal: 'Complete the workflow.',
        maxSteps: 5
      });
      if (!txRes.success) return { ok: false, error: txRes.error };

      const tx = txRes.transaction;
      let observationPasses = 0;
      const tStart = performance.now();

      const loopRes = await coordinator.runTransactionLoop(tx.transactionId, {
        observePage: async (tabId, generation) => {
          observationPasses++;
          const invResp = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, { type: 'QUERY_GROUNDING', query: 'inventory', generation }, resolve);
          });
          return {
            tabId,
            generation,
            elementCount: invResp.inventory?.length || 0,
            inventory: invResp.inventory || []
          };
        },
        planStep: async (context, goal, history) => {
          // Model reasons over current observed page state
          const startItem = context.inventory.find(i => i.text.toLowerCase().includes('start'));
          const continueItem = context.inventory.find(i => i.text.toLowerCase().includes('continue'));

          if (startItem) {
            return {
              status: 'continue',
              reason: 'Start button found. Proceeding with initial step.',
              action: { type: 'click', elementId: startItem.elementId }
            };
          }
          if (continueItem) {
            return {
              status: 'continue',
              reason: 'Continue button found. Proceeding with final step.',
              action: { type: 'click', elementId: continueItem.elementId }
            };
          }
          // Workflow complete
          return {
            status: 'done',
            message: 'Workflow successfully completed.'
          };
        },
        groundAction: (action, generation, tabId) => {
          return { success: true, elementId: action.elementId };
        },
        validateAction: () => ({ allowed: true }),
        executeAction: async (action, generation) => {
          return new Promise((resolve) => {
            chrome.tabs.sendMessage(tId, { type: 'EXECUTE_ACTION', action, tabId: tId }, (res) => {
              resolve(res || { success: false, error: 'EXEC_FAILED' });
            });
          });
        },
        settleWait: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 400))),
        onStatusUpdate: () => {}
      });

      const totalDuration = performance.now() - tStart;
      return {
        ok: loopRes.success,
        status: loopRes.status,
        error: loopRes.error,
        stepsExecuted: loopRes.stepsExecuted,
        finalMessage: loopRes.finalMessage,
        observationPasses,
        historyCount: tx.history.length,
        durationMs: totalDuration
      };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Workflow Execution Result:', workflowResult);
    if (!workflowResult.ok || workflowResult.stepsExecuted !== 2) {
      throw new Error(`Multi-step workflow failed: ${JSON.stringify(workflowResult)}`);
    }

    // Verify real DOM in page reflects both transitions and final completion
    const domState = await page.evaluate(() => ({
      step1: window.__step1Completed === true,
      step2: window.__step2Completed === true,
      successText: document.getElementById('success')?.textContent || null
    }));
    console.log('DOM State After Agent Execution:', domState);
    if (!domState.step1 || !domState.step2 || domState.successText !== 'Workflow Complete') {
      throw new Error(`Real page DOM did not reflect completed workflow!`);
    }
    console.log('[PASS] Multi-step agent loop completed exactly 2 actions with fresh observations and DOM verification.');

    // =========================================================================
    // TEST 2: CONCURRENT SAME-TAB TRANSACTION (TRANSACTION_ACTIVE)
    // =========================================================================
    console.log('\n--- TEST 2: Concurrent Same-Tab Transaction Rejection ---');
    const concurrencyResult = await serviceWorker.evaluate((tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();
      const first = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'first' });
      const second = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'second' });
      return {
        firstOk: first.success,
        secondOk: second.success,
        secondError: second.error
      };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Concurrency Result:', concurrencyResult);
    if (!concurrencyResult.firstOk || concurrencyResult.secondOk || concurrencyResult.secondError !== 'TRANSACTION_ACTIVE') {
      throw new Error(`Concurrent transaction on same tab was not rejected with TRANSACTION_ACTIVE!`);
    }
    console.log('[PASS] Concurrent transaction on same tab deterministically rejected.');

    // =========================================================================
    // TEST 3: REPEATED UNCHANGED ACTION TRIGGERS LOOP_DETECTED
    // =========================================================================
    console.log('\n--- TEST 3: Loop Detection ---');
    const loopResult = await serviceWorker.evaluate(async (tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();
      const txRes = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'loop test' });

      const res = await coordinator.runTransactionLoop(txRes.transaction.transactionId, {
        observePage: async () => ({ tabId: tId, generation: gen, elementCount: 2 }),
        planStep: async () => ({ status: 'continue', action: { type: 'click', elementId: 'el_static' } }),
        groundAction: () => ({ success: true, elementId: 'el_static' }),
        validateAction: () => ({ allowed: true }),
        executeAction: async () => ({ success: true }), // succeeds but page doesn't change
        settleWait: async () => {}
      });

      return { ok: res.success, error: res.error, status: res.status };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Loop Detection Result:', loopResult);
    if (loopResult.ok || loopResult.error !== 'LOOP_DETECTED') {
      throw new Error(`Unchanged repeated action did not trigger LOOP_DETECTED: ${JSON.stringify(loopResult)}`);
    }
    console.log('[PASS] Repeated unchanged action triggered LOOP_DETECTED safely.');

    // =========================================================================
    // TEST 4: HARD STEP LIMIT (MAX_STEPS_REACHED)
    // =========================================================================
    console.log('\n--- TEST 4: Hard Step Limit Enforcement ---');
    const stepLimitResult = await serviceWorker.evaluate(async (tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();
      const txRes = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'limit test' });
      let count = 0;

      const res = await coordinator.runTransactionLoop(txRes.transaction.transactionId, {
        observePage: async () => ({ tabId: tId, generation: gen, elementCount: ++count }),
        planStep: async () => ({ status: 'continue', action: { type: 'click', elementId: `el_${count}` } }),
        groundAction: () => ({ success: true, elementId: `el_${count}` }),
        validateAction: () => ({ allowed: true }),
        executeAction: async () => ({ success: true }),
        settleWait: async () => {}
      });

      return { ok: res.success, error: res.error, stepsExecuted: res.stepsExecuted };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Step Limit Result:', stepLimitResult);
    if (stepLimitResult.ok || stepLimitResult.error !== 'MAX_STEPS_REACHED' || stepLimitResult.stepsExecuted !== 5) {
      throw new Error(`Step limit enforcement failed: ${JSON.stringify(stepLimitResult)}`);
    }
    console.log('[PASS] Hard step limit of 5 actions strictly enforced.');

    // =========================================================================
    // TEST 5: FAILED ACTION BOUNDED RETRY (MAX 1 RETRY)
    // =========================================================================
    console.log('\n--- TEST 5: Failed Action Bounded Retry ---');
    const retryResult = await serviceWorker.evaluate(async (tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();
      const txRes = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'retry test' });
      let attempts = 0;

      const res = await coordinator.runTransactionLoop(txRes.transaction.transactionId, {
        observePage: async () => ({ tabId: tId, generation: gen }),
        planStep: async () => ({ status: 'continue', action: { type: 'click', elementId: 'el_fail' } }),
        groundAction: () => ({ success: true, elementId: 'el_fail' }),
        validateAction: () => ({ allowed: true }),
        executeAction: async () => {
          attempts++;
          return { success: false, error: 'CLICK_REJECTED' };
        },
        settleWait: async () => {}
      });

      return { ok: res.success, attempts, error: res.error };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Retry Result:', retryResult);
    if (retryResult.ok || retryResult.attempts !== 2) {
      throw new Error(`Failed action did not obey max 1 retry policy: ${JSON.stringify(retryResult)}`);
    }
    console.log('[PASS] Failed action halted safely after exactly 1 bounded retry.');

    // =========================================================================
    // TEST 6: PROVIDER FAILURE SAFE TERMINATION
    // =========================================================================
    console.log('\n--- TEST 6: Provider Failure Safe Termination ---');
    const providerFailResult = await serviceWorker.evaluate(async (tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();
      const txRes = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'provider fail test' });

      const res = await coordinator.runTransactionLoop(txRes.transaction.transactionId, {
        observePage: async () => ({ tabId: tId, generation: gen }),
        planStep: async () => {
          throw new Error('Remote Provider Error 500');
        },
        groundAction: () => ({ success: true }),
        validateAction: () => ({ allowed: true }),
        executeAction: async () => ({ success: true })
      });

      return { ok: res.success, error: res.error };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Provider Failure Result:', providerFailResult);
    if (providerFailResult.ok || providerFailResult.error !== 'PROVIDER_FAILED') {
      throw new Error(`Provider failure was not handled safely: ${JSON.stringify(providerFailResult)}`);
    }
    console.log('[PASS] Provider failure terminated transaction safely without uncaught errors.');

    // =========================================================================
    // TEST 7: NAVIGATION RACE / STALE TRANSACTION TERMINATION
    // =========================================================================
    console.log('\n--- TEST 7: Navigation During Agent Transaction ---');
    const navResult = await serviceWorker.evaluate(async (tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();
      const txRes = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'nav test' });

      // Simulate navigation invalidating generation
      coordinator.handleNavigation(tId, gen + 1);
      const tx = coordinator.getTransaction(txRes.transaction.transactionId);
      return { status: tx?.status, error: tx?.error };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Navigation Result:', navResult);
    if (navResult.status !== 'STALE' || navResult.error !== 'PAGE_CHANGED') {
      throw new Error(`Navigation failed to invalidate active transaction: ${JSON.stringify(navResult)}`);
    }
    console.log('[PASS] Navigation immediately invalidated active transaction as STALE.');

    // =========================================================================
    // TEST 8: TAB CLOSE TERMINATION
    // =========================================================================
    console.log('\n--- TEST 8: Tab Close Termination ---');
    const closeResult = await serviceWorker.evaluate(async (tId, gen) => {
      const coordinator = self.SIH_AgentCoordinator;
      coordinator.resetAll();
      const txRes = coordinator.createTransaction({ tabId: tId, generation: gen, goal: 'close test' });

      coordinator.handleTabClosed(tId);
      const tx = coordinator.getTransaction(txRes.transaction.transactionId);
      const active = coordinator.getActiveTransaction(tId);
      return { status: tx?.status, error: tx?.error, hasActive: active !== null };
    }, tabInfo.tabId, tabInfo.generation);

    console.log('Tab Close Result:', closeResult);
    if (closeResult.status !== 'FAILED' || closeResult.error !== 'TAB_CLOSED' || closeResult.hasActive) {
      throw new Error(`Tab close failed to terminate transaction and clear active registry: ${JSON.stringify(closeResult)}`);
    }
    console.log('[PASS] Tab closure terminated transaction and cleared tab association.');

    // =========================================================================
    // PRIVACY & LOG AUDIT
    // =========================================================================
    console.log('\n--- SERVICE WORKER CONSOLE LOG AUDIT ---');
    console.log(`Total SW log lines captured: ${swLogs.length}`);
    console.log(`Base64 image leak detections: ${base64Leaks}`);
    console.log(`API key leak detections: ${keyLeaks}`);
    console.log(`Raw OCR text leak detections: ${ocrTextLeaks}`);

    if (base64Leaks > 0) throw new Error(`Privacy violation: ${base64Leaks} base64 screenshot leaks detected in logs.`);
    if (keyLeaks > 0) throw new Error(`Privacy violation: ${keyLeaks} API key leaks detected in logs.`);
    if (ocrTextLeaks > 0) throw new Error(`Privacy violation: ${ocrTextLeaks} raw OCR text leaks detected in logs.`);

    console.log('[PASS] Zero image leaks, zero key leaks, and zero raw OCR text leaks in logs.');

    console.log('\n===============================================================');
    console.log('ALL PHASE 8 REAL CHROME AGENT LOOP TESTS PASSED 100%');
    console.log('===============================================================');

  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => {
  console.error('\n[FAIL] Phase 8 test failed with exception:', err);
  process.exit(1);
});
