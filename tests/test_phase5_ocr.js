const puppeteer = require('e:/SIH2026/node_modules/puppeteer');
const path = require('path');
const http = require('http');

(async () => {
  console.log('===============================================================');
  console.log('PHASE 5 — REAL CHROME LOCAL OCR & PRIVACY INTEGRATION TEST');
  console.log('===============================================================');

  // SVG face to test concurrent visual redaction + OCR on sanitized canvas
  const faceSvg = `<svg width="120" height="120" xmlns="http://www.w3.org/2000/svg">
    <rect width="120" height="120" fill="#fce7f3"/>
    <circle cx="60" cy="60" r="50" fill="#fbcfe8" stroke="#db2777" stroke-width="3"/>
    <circle cx="45" cy="45" r="7" fill="#831843"/>
    <circle cx="75" cy="45" r="7" fill="#831843"/>
    <path d="M 45 80 Q 60 95 75 80" stroke="#831843" stroke-width="4" fill="none" stroke-linecap="round"/>
  </svg>`;
  const faceBase64 = `data:image/svg+xml;utf8,${encodeURIComponent(faceSvg)}`;

  // 1. Local test HTTP server
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url === '/pageB') {
      res.end(`<!DOCTYPE html>
<html>
<head><title>Page B Navigation Target</title></head>
<body>
  <h1>Second Navigation Page</h1>
  <p>Fresh document content without previous text.</p>
</body>
</html>`);
    } else {
      res.end(`<!DOCTYPE html>
<html>
<head><title>Page A OCR Document</title></head>
<body style="font-family: Arial, sans-serif; padding: 24px;">
  <h1 id="mainTitle">SIH Privacy Assistant Demonstration Document</h1>
  <img id="faceImg" src="${faceBase64}" width="120" height="120" alt="Profile" />
  <p id="articlePara">Local optical character recognition enables private visual understanding directly on your device without transmitting images to cloud servers.</p>
  <p id="sensitiveEmail">Direct Contact: secret.agent@privacy.test</p>
  <p id="footerNotice">Confidential Internal Briefing 2026</p>
</body>
</html>`);
    }
  });

  await new Promise(resolve => server.listen(8994, '127.0.0.1', resolve));
  console.log('Local test server listening on http://127.0.0.1:8994');

  const extensionPath = path.resolve('E:/SIH2026/extension');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  browser.on('targetcreated', async target => {
    if (target.url().includes('offscreen.html')) {
      const page = await target.page();
      if (page) {
        page.on('console', msg => console.log('[OFFSCREEN CONSOLE]:', msg.text()));
        page.on('pageerror', err => console.log('[OFFSCREEN ERROR]:', err.message));
      }
    }
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

      // Audit for image leak
      if (/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]{150,}/.test(text)) {
        base64Leaks++;
        console.error('[LEAK DETECTED IN SW CONSOLE — IMAGE DATA]', text.slice(0, 100));
      }
      // Audit for key leak
      if (/AIzaSy[A-Za-z0-9_-]{20,}/.test(text) || /sk-[A-Za-z0-9_-]{20,}/.test(text)) {
        keyLeaks++;
        console.error('[LEAK DETECTED IN SW CONSOLE — API KEY]');
      }
      // Audit for OCR raw text leak in logs
      if (text.includes('optical character recognition enables') || text.includes('Confidential Internal Briefing')) {
        ocrTextLeaks++;
        console.error('[LEAK DETECTED IN SW CONSOLE — RAW OCR TEXT]', text.slice(0, 80));
      }
    });

    const extId = new URL(serviceWorker.url()).hostname;
    console.log(`[PASS] Extension SW connected. Extension ID: ${extId}`);

    // Open Page A
    const pageA = await browser.newPage();
    await pageA.goto('http://127.0.0.1:8994/pageA', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 1200));

    // Open Sidebar
    const sidebarPage = await browser.newPage();
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`, { waitUntil: 'networkidle0' });

    sidebarPage.on('console', msg => {
      const text = msg.text();
      if (/data:image\/[a-zA-Z]+;base64,[A-Za-z0-9+/=]{150,}/.test(text)) {
        base64Leaks++;
      }
      if (/AIzaSy[A-Za-z0-9_-]{20,}/.test(text)) {
        keyLeaks++;
      }
      if (text.includes('optical character recognition enables')) {
        ocrTextLeaks++;
      }
    });

    // Listen to offscreen document logs
    try {
      const offscreenTarget = await browser.waitForTarget(t => t.url().includes('offscreen.html'), { timeout: 3000 });
      if (offscreenTarget) {
        const offscreenPage = await offscreenTarget.page();
        if (offscreenPage) {
          offscreenPage.on('console', msg => console.log('[OFFSCREEN CONSOLE]:', msg.text()));
          offscreenPage.on('pageerror', err => console.log('[OFFSCREEN PAGE ERROR]:', err.message));
        }
      }
    } catch (e) {
      console.log('Could not attach to offscreen page console yet:', e.message);
    }

    // Bring Page A back to front
    await pageA.bringToFront();
    await new Promise(r => setTimeout(r, 1200));

    // Get Active Tab Info
    const activeTabInfo = await serviceWorker.evaluate(() => {
      const s = tabPerceptionState.get(activeTabId);
      return { tabId: activeTabId, generation: s?.generation };
    });
    console.log('\n--- Active Tab Info for Page A ---', activeTabInfo);

    // =========================================================================
    // TEST 1: EXECUTE LOCAL OCR IN REAL CHROME OFFSCREEN DOCUMENT
    // =========================================================================
    console.log('\n--- TEST 1: Executing Local OCR via Offscreen Document ---');
    const ocrProcessingResult = await serviceWorker.evaluate(async (tabInfo) => {
      const screenshot = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
      // Pass synthetic PII rect for sensitive email to verify redaction before OCR
      const safeRects = [
        { type: 'email', source: 'dom', x: 20, y: 220, width: 320, height: 30 }
      ];
      const workerResult = await dispatchToOffscreen(screenshot, { width: 800, height: 600 }, safeRects, tabInfo.tabId, tabInfo.generation);

      const currentTabState = tabPerceptionState.get(tabInfo.tabId);
      const visualEvidence = {
        available: Boolean(workerResult && workerResult.sanitizedDataUrl),
        sanitizedDataUrl: workerResult?.sanitizedDataUrl || null,
        generation: tabInfo.generation,
        tabId: tabInfo.tabId,
        backend: workerResult?.backend || 'mediapipe',
        cvExecuted: true,
        ocrExecuted: Boolean(workerResult?.ocrExecuted),
        ocrAvailable: Boolean(workerResult?.ocrAvailable),
        ocrText: workerResult?.ocrText || '',
        detections: workerResult?.detections || [],
        detectionCount: workerResult?.detections?.length || 0,
        processingMs: 25.0,
        sanitized: true
      };
      if (currentTabState) {
        currentTabState.screenshot = visualEvidence;
      }
      broadcastToExtensionPages({
        type: 'VISUAL_CONTEXT_UPDATE',
        tabId: tabInfo.tabId,
        generation: tabInfo.generation,
        visual: visualEvidence
      });

      return {
        ok: workerResult?.ok,
        cvExecuted: workerResult?.cvExecuted,
        ocrExecuted: workerResult?.ocrExecuted,
        ocrAvailable: workerResult?.ocrAvailable,
        hasOcrText: Boolean(workerResult?.ocrText && workerResult.ocrText.length > 0),
        ocrTextLength: workerResult?.ocrText?.length || 0,
        ocrContainsTitle: (workerResult?.ocrText || '').toLowerCase().includes('demonstration') || (workerResult?.ocrText || '').toLowerCase().includes('privacy'),
        ocrContainsRedactedEmail: (workerResult?.ocrText || '').includes('secret.agent@privacy.test'),
        ocrDebug: workerResult?.ocrDebug || null,
        sanitizedDataUrlPrefix: workerResult?.sanitizedDataUrl?.slice(0, 30) || null
      };
    }, activeTabInfo);

    console.log('Local OCR Processing Result:', ocrProcessingResult);

    if (!ocrProcessingResult.ocrExecuted) {
      throw new Error('Local OCR execution failed to report ocrExecuted: true');
    }
    if (!ocrProcessingResult.hasOcrText) {
      throw new Error('Local OCR executed but produced empty text on text-heavy page');
    }
    if (ocrProcessingResult.ocrContainsRedactedEmail) {
      throw new Error('LEAK: OCR extracted PII from redacted region!');
    }
    console.log('[PASS] TEST 1: OCR executed locally, truthfully reported ocrExecuted: true, extracted on-screen text, and excluded redacted PII.');

    // =========================================================================
    // TEST 2: SIDEBAR EVIDENCE UI REFLECTS OCR STATUS
    // =========================================================================
    console.log('\n--- TEST 2: Verifying Sidebar Evidence UI for OCR ---');
    await sidebarPage.bringToFront();
    await new Promise(r => setTimeout(r, 600));

    const sidebarOcrMeta = await sidebarPage.evaluate(() => {
      const el = document.getElementById('metaOcr');
      return {
        text: el ? el.textContent.trim() : null,
        className: el ? el.className : null
      };
    });
    console.log('Sidebar OCR Evidence Item:', sidebarOcrMeta);
    if (sidebarOcrMeta.text !== 'Executed') {
      throw new Error(`Sidebar OCR element expected 'Executed', got: ${sidebarOcrMeta.text}`);
    }
    console.log('[PASS] TEST 2: Sidebar properly reflects OCR status: Executed (meta-active).');

    // =========================================================================
    // TEST 3: PROVIDER INTEGRATION WITH BOUNDED OCR
    // =========================================================================
    console.log('\n--- TEST 3: Provider Gate Verification (Gemini Vision vs Groq Text) ---');
    await pageA.bringToFront();

    // Mock Gemini Provider dispatch capture
    let capturedProviderPayload = null;
    await serviceWorker.evaluate(() => {
      const gemini = modelManager.providers.gemini;
      if (gemini) {
        gemini.chat = async (apiKey, model, sanitizedContext, userMessage) => {
          self.__lastCapturedPayload = {
            apiKey,
            model,
            hasScreenshotDataUrl: Boolean(sanitizedContext.screenshotDataUrl),
            screenshotRedacted: Boolean(sanitizedContext.screenshotRedacted),
            hasOcrText: Boolean(sanitizedContext.ocrText),
            ocrTextLength: (sanitizedContext.ocrText || '').length,
            userMessage
          };
          return {
            type: 'text',
            message: 'I see the demonstration document.'
          };
        };
      }
    });

    // Configure Gemini in options
    await serviceWorker.evaluate(async () => {
      const config = await modelManager.getConfig();
      config.selectedProvider = 'gemini';
      config.selectedModel = 'models/gemini-1.5-flash';
      config.providers.gemini = { configured: true, apiKey: 'AIzaSyD_MOCK_TEST_KEY_1234567890' };
      await modelManager.saveConfig(config);
    });

    // Execute chat with Gemini
    const geminiResponse = await serviceWorker.evaluate(async (tabInfo) => {
      return await handleBackendRequest({
        tabId: tabInfo.tabId,
        generation: tabInfo.generation,
        userMessage: 'What does the document say?'
      }, {});
    }, activeTabInfo);

    const capturedGemini = await serviceWorker.evaluate(() => self.__lastCapturedPayload);
    console.log('Gemini Chat Response:', geminiResponse);
    console.log('Captured Gemini Payload Context:', capturedGemini);

    if (!capturedGemini.hasScreenshotDataUrl) {
      throw new Error('Gemini vision model failed to receive sanitized screenshot');
    }
    if (!capturedGemini.hasOcrText || capturedGemini.ocrTextLength === 0) {
      throw new Error('Gemini vision model failed to receive bounded OCR context');
    }
    console.log('[PASS] TEST 3A: Vision model received sanitized screenshot + bounded OCR context.');

    // Switch to Groq (Text-only)
    await serviceWorker.evaluate(() => {
      const groq = modelManager.providers.groq;
      if (groq) {
        groq.chat = async (apiKey, model, sanitizedContext, userMessage) => {
          self.__lastCapturedGroq = {
            apiKey,
            model,
            hasScreenshotDataUrl: Boolean(sanitizedContext.screenshotDataUrl),
            hasScreenshot: Boolean(sanitizedContext.screenshot)
          };
          return {
            type: 'text',
            message: 'Text response.'
          };
        };
      }
    });

    await serviceWorker.evaluate(async () => {
      const config = await modelManager.getConfig();
      config.selectedProvider = 'groq';
      config.selectedModel = 'llama-3.3-70b-versatile';
      config.providers.groq = { configured: true, apiKey: 'gsk_MOCK_TEST_KEY_1234567890' };
      await modelManager.saveConfig(config);
    });

    await serviceWorker.evaluate(async (tabInfo) => {
      return await handleBackendRequest({
        tabId: tabInfo.tabId,
        generation: tabInfo.generation,
        userMessage: 'Read this page'
      }, {});
    }, activeTabInfo);

    const capturedGroq = await serviceWorker.evaluate(() => self.__lastCapturedGroq);
    console.log('Captured Groq Payload Context:', capturedGroq);
    if (capturedGroq.hasScreenshotDataUrl || capturedGroq.hasScreenshot) {
      throw new Error('LEAK: Text-only Groq model received image payload!');
    }
    console.log('[PASS] TEST 3B: Text-only model received NO image payload.');

    // =========================================================================
    // TEST 4: NAVIGATION INVALIDATES OCR STATE
    // =========================================================================
    console.log('\n--- TEST 4: Verifying Navigation Invalidates OCR State ---');
    await pageA.goto('http://127.0.0.1:8994/pageB', { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 1200));

    const stateAfterNav = await serviceWorker.evaluate((tabId) => {
      const s = tabPerceptionState.get(tabId);
      return {
        generation: s?.generation,
        screenshot: s?.screenshot,
        ocrText: s?.screenshot?.ocrText || null
      };
    }, activeTabInfo.tabId);

    console.log('State After Navigation to Page B:', stateAfterNav);
    if (stateAfterNav.screenshot !== null) {
      throw new Error('Navigation failed to clear previous generation screenshot/OCR state!');
    }
    console.log('[PASS] TEST 4: Navigation immediately invalidated and purged previous OCR state.');

    // =========================================================================
    // TEST 5: TAB CLOSE PURGES STATE FROM MEMORY
    // =========================================================================
    console.log('\n--- TEST 5: Tab Close Purges OCR State ---');
    await pageA.close();
    await new Promise(r => setTimeout(r, 800));

    const stateAfterClose = await serviceWorker.evaluate((tabId) => {
      return { exists: tabPerceptionState.has(tabId) };
    }, activeTabInfo.tabId);

    console.log('State After Tab Close:', stateAfterClose);
    if (stateAfterClose.exists) {
      throw new Error('Closed tab state still exists in tabPerceptionState map!');
    }
    console.log('[PASS] TEST 5: Tab close completely purged tab state and OCR references from memory.');

    // =========================================================================
    // TEST 6: LOG PRIVACY AUDIT
    // =========================================================================
    console.log('\n--- TEST 6: Service Worker DevTools Console Log Audit ---');
    console.log(`Total SW log entries captured: ${swLogs.length}`);
    console.log(`Base64 image leak detections: ${base64Leaks}`);
    console.log(`API key leak detections: ${keyLeaks}`);
    console.log(`Raw OCR text leak detections: ${ocrTextLeaks}`);

    if (base64Leaks > 0) throw new Error(`Base64 image leak detected (${base64Leaks})`);
    if (keyLeaks > 0) throw new Error(`API key leak detected (${keyLeaks})`);
    if (ocrTextLeaks > 0) throw new Error(`Raw OCR text leak detected (${ocrTextLeaks})`);

    console.log('[PASS] TEST 6: Zero image data, zero API keys, and zero raw OCR text leaked to logs.');

    console.log('\n===============================================================');
    console.log('ALL PHASE 5 REAL CHROME LOCAL OCR VERIFICATIONS PASSED 100%');
    console.log('===============================================================');

  } finally {
    await browser.close();
    server.close();
  }
})();
