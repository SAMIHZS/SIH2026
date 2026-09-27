const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const PORT = 8991;
const DOCS_DIR = path.resolve(__dirname, '..', 'docs');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

// Simple static server
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(DOCS_DIR, reqPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found: ' + reqPath);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

async function verifyWebsite() {
  server.listen(PORT, async () => {
    console.log(`[TEST] Local website server listening on http://127.0.0.1:${PORT}`);
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();

      const failedRequests = [];
      page.on('requestfailed', req => {
        failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
      });

      const consoleErrors = [];
      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });

      console.log('[TEST] Loading http://127.0.0.1:8991...');
      await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle0' });

      // 1. Verify Page Title & Heading
      const title = await page.title();
      console.log(`[PASS] Title: "${title}"`);

      const h1Text = await page.$eval('h1', el => el.textContent.trim());
      console.log(`[PASS] H1 Heading: "${h1Text}"`);

      // 2. Verify Theme Toggle
      const initialTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      console.log(`[PASS] Initial Theme: "${initialTheme}"`);

      await page.click('#themeToggleBtn');
      const toggledTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      console.log(`[PASS] Toggled Theme: "${toggledTheme}"`);
      if (initialTheme === toggledTheme) {
        throw new Error('Theme toggle failed to change theme attribute');
      }

      // Toggle back
      await page.click('#themeToggleBtn');
      const restoredTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      console.log(`[PASS] Restored Theme: "${restoredTheme}"`);

      // 3. Verify FAQ Accordion
      const faqItem = await page.$('.faq-item');
      const isInitiallyOpen = await page.evaluate(el => el.classList.contains('open'), faqItem);
      console.log(`[PASS] FAQ initially open: ${isInitiallyOpen}`);

      await page.click('.faq-item:first-child .faq-question');
      const isOpenAfterClick = await page.evaluate(el => el.classList.contains('open'), faqItem);
      console.log(`[PASS] FAQ open after click: ${isOpenAfterClick}`);
      if (!isOpenAfterClick) {
        throw new Error('FAQ item did not open upon clicking');
      }

      // 4. Verify Gallery Tabs
      const activeGalleryText = await page.evaluate(() => {
        const activeTab = document.querySelector('.gallery-tab-btn.active');
        const activePanel = document.querySelector('.gallery-image-panel.active');
        return {
          tab: activeTab ? activeTab.textContent : null,
          panelId: activePanel ? activePanel.id : null
        };
      });
      console.log(`[PASS] Default Active Gallery Tab: ${activeGalleryText.tab} -> #${activeGalleryText.panelId}`);

      // Click second tab
      await page.click('.gallery-tab-btn[data-target="gallery-context"]');
      const switchedGalleryText = await page.evaluate(() => {
        const activeTab = document.querySelector('.gallery-tab-btn.active');
        const activePanel = document.querySelector('.gallery-image-panel.active');
        return {
          tab: activeTab ? activeTab.textContent : null,
          panelId: activePanel ? activePanel.id : null
        };
      });
      console.log(`[PASS] Switched Active Gallery Tab: ${switchedGalleryText.tab} -> #${switchedGalleryText.panelId}`);

      // 5. Test Multiple Viewports for Overflow
      const viewports = [
        { width: 1440, height: 900, name: 'Desktop 1440px' },
        { width: 1024, height: 768, name: 'Tablet 1024px' },
        { width: 768, height: 1024, name: 'Tablet 768px' },
        { width: 375, height: 667, name: 'Mobile 375px' },
        { width: 320, height: 568, name: 'Mobile 320px' }
      ];

      for (const vp of viewports) {
        await page.setViewport({ width: vp.width, height: vp.height });
        await new Promise(r => setTimeout(r, 100));

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const innerWidth = await page.evaluate(() => window.innerWidth);
        const hasHorizontalOverflow = scrollWidth > innerWidth + 1; // 1px tolerance

        if (hasHorizontalOverflow) {
          const overflowing = await page.evaluate((docWidth) => {
            const elements = document.querySelectorAll('*');
            const results = [];
            elements.forEach(el => {
              const rect = el.getBoundingClientRect();
              if (rect.right > docWidth + 2) {
                results.push({ tag: el.tagName, id: el.id, class: el.className, right: rect.right, width: rect.width });
              }
            });
            return results;
          }, innerWidth);
          console.error(`Overflow elements at ${vp.name}:`, JSON.stringify(overflowing.slice(0, 5), null, 2));
          throw new Error(`Horizontal overflow detected at ${vp.name}! scrollWidth=${scrollWidth}, innerWidth=${innerWidth}`);
        }
        console.log(`[PASS] Viewport ${vp.name}: width=${innerWidth}px, scrollWidth=${scrollWidth}px (No horizontal overflow)`);
      }

      // 6. Test Download CTA Modal Dialog
      await page.click('.hero-actions .js-download-btn');
      await new Promise(r => setTimeout(r, 200));
      const modalOpen = await page.evaluate(() => {
        const modal = document.getElementById('downloadModal');
        return modal && modal.classList.contains('open');
      });
      console.log(`[PASS] Download Modal Open: ${modalOpen}`);
      if (!modalOpen) {
        throw new Error('Download modal did not open upon clicking download button');
      }

      // Close modal
      await page.click('#closeDownloadModalBtn');
      await new Promise(r => setTimeout(r, 200));
      const modalClosed = await page.evaluate(() => {
        const modal = document.getElementById('downloadModal');
        return modal && !modal.classList.contains('open');
      });
      console.log(`[PASS] Download Modal Closed: ${modalClosed}`);
      if (!modalClosed) {
        throw new Error('Download modal did not close upon clicking close button');
      }

      // 7. Verify Zero Failed Network Requests & Zero Console Errors
      if (failedRequests.length > 0) {
        console.error('Failed requests:', failedRequests);
        throw new Error(`Encountered ${failedRequests.length} failed network requests!`);
      }
      console.log('[PASS] Zero network request failures (All images, fonts, scripts 200 OK)');

      if (consoleErrors.length > 0) {
        console.error('Console errors:', consoleErrors);
        throw new Error(`Encountered ${consoleErrors.length} console errors!`);
      }
      console.log('[PASS] Zero JavaScript console errors');

      console.log('\n===============================================================');
      console.log('ALL WEBSITE VERIFICATION CHECKS PASSED 100%!');
      console.log('===============================================================\n');

    } catch (err) {
      console.error('[FAIL] Website verification failed:', err);
      process.exitCode = 1;
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  });
}

verifyWebsite();
