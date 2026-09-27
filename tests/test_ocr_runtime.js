const puppeteer = require('puppeteer');
const path = require('path');
const assert = require('assert');

(async () => {
  console.log('===============================================================');
  console.log('PHASE 5 — LOW-LEVEL OCR RUNTIME & OFFSCREENCANVAS TEST');
  console.log('===============================================================');

  const extensionPath = path.resolve('E:/SIH2026/extension');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker', { timeout: 10000 });
    const sw = await swTarget.worker();
    const extId = new URL(sw.url()).hostname;
    console.log(`[PASS] Extension SW connected. Extension ID: ${extId}`);

    // Navigate to offscreen document inside extension context
    const offscreenPage = await browser.newPage();
    offscreenPage.on('console', msg => console.log('[OFFSCREEN CONSOLE]:', msg.text()));
    offscreenPage.on('pageerror', err => console.log('[OFFSCREEN ERROR]:', err.message));
    await offscreenPage.goto(`chrome-extension://${extId}/offscreen.html`, { waitUntil: 'networkidle0' });

    // Execute low-level OCR test inside offscreen document
    console.log('\n--- Testing SIH_OcrDetector with OffscreenCanvas ("HELLO OCR") ---');
    const result = await offscreenPage.evaluate(async () => {
      // 1. Create OffscreenCanvas with "HELLO OCR"
      const oc = new OffscreenCanvas(400, 150);
      const ctx = oc.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 400, 150);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 36px Arial, sans-serif';
      ctx.fillText('HELLO OCR', 20, 85);

      // 2. Check SIH_OcrDetector availability
      const detector = window.SIH_OcrDetector || self.SIH_OcrDetector;
      if (!detector) {
        return { ok: false, error: 'SIH_OcrDetector global not found' };
      }
      if (!detector.isAvailable()) {
        return { ok: false, error: 'SIH_OcrDetector reports isAvailable: false' };
      }

      // 3. Test loadRuntime()
      const runtime = await detector.loadRuntime();
      if (!runtime) {
        return { ok: false, error: 'detector.loadRuntime() returned null' };
      }

      // 4. Test createWorker()
      const worker = await detector.createWorker();
      if (!worker) {
        return { ok: false, error: 'detector.createWorker() returned null' };
      }

      // 5. Test worker.recognize(oc) directly on OffscreenCanvas
      const inferenceStarted = performance.now();
      const ocrResult = await worker.recognize(oc);
      const inferenceMs = performance.now() - inferenceStarted;

      // 6. Test terminate()
      await detector.terminate();

      const text = ocrResult?.data?.text || '';
      return {
        ok: true,
        text,
        inferenceMs,
        hasHelloOcr: text.includes('HELLO OCR')
      };
    });

    console.log('Low-level OCR Result:', result);

    if (!result.ok) {
      throw new Error(`OCR Runtime execution failed: ${result.error}`);
    }
    if (!result.hasHelloOcr) {
      throw new Error(`OCR failed to recognize "HELLO OCR". Extracted: "${result.text ? result.text.trim() : ''}"`);
    }

    console.log(`\n[PASS] Low-level OCR runtime successfully recognized: "HELLO OCR" (inference time: ${result.inferenceMs.toFixed(1)}ms)`);
    console.log('===============================================================');
    console.log('LOW-LEVEL OCR RUNTIME TEST PASSED 100%');
    console.log('===============================================================');

  } finally {
    await browser.close();
  }
})();
