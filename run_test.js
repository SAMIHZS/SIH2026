const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const extensionPath = path.join(__dirname, 'extension');
  const testPagePath = 'file:///' + path.join(__dirname, 'tests', 'test_controlled_pii_face.html').replace(/\\/g, '/');

  console.log('Loading extension from:', extensionPath);
  console.log('Opening test page:', testPagePath);

  const browser = await puppeteer.launch({
    headless: 'new', // or false if debugging locally, but we need new headless for extensions in newer puppeteer
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  const page = await browser.newPage();

  // Route page logs
  page.on('console', msg => {
    console.log(`[PAGE] ${msg.type().toUpperCase()}: ${msg.text()}`);
  });
  page.on('pageerror', err => {
    console.error(`[PAGE] ERROR: ${err.message}`);
  });

  // Attach to existing targets
  for (const target of browser.targets()) {
    if (target.type() === 'service_worker') {
      try {
        const worker = await target.worker();
        if (worker) {
          worker.on('console', msg => console.log(`[SW] ${msg.type().toUpperCase()}: ${msg.text()}`));
          worker.on('error', err => console.error(`[SW] ERROR: ${err.message}`));
          console.log('[Puppeteer] Attached to existing Service Worker');
        }
      } catch (err) {}
    } else if (target.url().includes('offscreen.html')) {
      try {
        const offscreenPage = await target.page();
        if (offscreenPage) {
          offscreenPage.on('console', msg => console.log(`[OFFSCREEN] ${msg.type().toUpperCase()}: ${msg.text()}`));
          offscreenPage.on('pageerror', err => console.error(`[OFFSCREEN] ERROR: ${err.message}`));
          console.log('[Puppeteer] Attached to existing Offscreen Document');
        }
      } catch (err) {}
    }
  }

  // Listen for future target created
  browser.on('targetcreated', async target => {
    if (target.type() === 'service_worker') {
      try {
        const worker = await target.worker();
        if (worker) {
          worker.on('console', msg => {
            console.log(`[SW] ${msg.type().toUpperCase()}: ${msg.text()}`);
          });
          worker.on('error', err => {
            console.error(`[SW] ERROR: ${err.message}`);
          });
          console.log('[Puppeteer] Attached to Service Worker');
        }
      } catch (err) {
        console.error('[Puppeteer] Failed to attach to SW:', err);
      }
    } else if (target.type() === 'other' || target.type() === 'page') {
      const targetUrl = target.url();
      if (targetUrl.includes('offscreen.html')) {
        try {
          const offscreenPage = await target.page();
          if (offscreenPage) {
            offscreenPage.on('console', msg => {
              console.log(`[OFFSCREEN] ${msg.type().toUpperCase()}: ${msg.text()}`);
            });
            offscreenPage.on('pageerror', err => {
              console.error(`[OFFSCREEN] ERROR: ${err.message}`);
            });
            console.log('[Puppeteer] Attached to Offscreen Document');
          }
        } catch (err) {
          console.error('[Puppeteer] Failed to attach to offscreen:', err);
        }
      }
    }
  });

  console.log('Navigating to test page...');
  await page.goto(testPagePath, { waitUntil: 'networkidle0', timeout: 10000 });
  await new Promise(r => setTimeout(r, 2000));
  console.log('Reloading to ensure clean state...');
  await page.reload({ waitUntil: 'networkidle0' });

  console.log('Waiting for visual pipeline to complete...');
  await new Promise(r => setTimeout(r, 5000));

  await browser.close();
  console.log('Done.');
})();
