/**
 * Phase 13 — Real Chrome Visual & Interaction Test
 * Verifies clean minimal sidebar UI, 3 tabs, settings modal, and captures screenshots
 */

'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

async function run() {
  console.log('===============================================================');
  console.log('PHASE 13 — SIDEBAR UX REAL-CHROME VERIFICATION');
  console.log('===============================================================');

  const screenshotsDir = path.resolve('E:/SIH2026/tests/screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const extensionPath = path.resolve('E:/SIH2026/extension');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  try {
    const workerTarget = await browser.waitForTarget(
      target => target.type() === 'service_worker' && target.url().includes('background.js'),
      { timeout: 10000 }
    );
    const extId = new URL(workerTarget.url()).hostname;
    console.log(`[PASS 1] Service worker active, extId=${extId}`);

    const sidebarPage = await browser.newPage();
    await sidebarPage.setViewport({ width: 380, height: 640 });
    await sidebarPage.goto(`chrome-extension://${extId}/sidebar.html`, { waitUntil: 'networkidle0' });
    console.log('[PASS 2] Sidebar loaded in real Chrome at 380x640');

    // ── Test Screen A: Default Chat ──
    const chatViewDisplay = await sidebarPage.$eval('#chatView', el => window.getComputedStyle(el).display);
    assert.strictEqual(chatViewDisplay, 'flex');
    const emptyStateVisible = await sidebarPage.$eval('#emptyState', el => window.getComputedStyle(el).display !== 'none');
    assert.strictEqual(emptyStateVisible, true);
    const composerVisible = await sidebarPage.$eval('.input-area', el => window.getComputedStyle(el).display !== 'none');
    assert.strictEqual(composerVisible, true);
    const chatPrivacyBadgeVisible = await sidebarPage.$eval('#chatPrivacyBadge', el => window.getComputedStyle(el).display !== 'none');
    assert.strictEqual(chatPrivacyBadgeVisible, true);

    await sidebarPage.screenshot({ path: path.join(screenshotsDir, 'phase13_chat_default.png') });
    console.log('[PASS 3] Screen A captured: Default Chat view (phase13_chat_default.png)');

    // ── Test Screen B: Context Tab ──
    await sidebarPage.click('#tabContext');
    await new Promise(r => setTimeout(r, 200));

    const contextViewDisplay = await sidebarPage.$eval('#contextView', el => window.getComputedStyle(el).display);
    assert.ok(contextViewDisplay === 'flex' || contextViewDisplay === 'block');
    const chatHidden = await sidebarPage.$eval('#chatView', el => window.getComputedStyle(el).display);
    assert.strictEqual(chatHidden, 'none');

    // Open accordion to show processing details
    await sidebarPage.click('#processingDetailsAccordion summary');
    await new Promise(r => setTimeout(r, 150));

    await sidebarPage.screenshot({ path: path.join(screenshotsDir, 'phase13_context.png') });
    console.log('[PASS 4] Screen B captured: Context view with processing details (phase13_context.png)');

    // ── Test Screen C: Privacy Tab ──
    await sidebarPage.click('#tabPrivacy');
    await new Promise(r => setTimeout(r, 200));

    const privacyViewDisplay = await sidebarPage.$eval('#privacyView', el => window.getComputedStyle(el).display);
    assert.ok(privacyViewDisplay === 'flex' || privacyViewDisplay === 'block');
    const privacyTitle = await sidebarPage.$eval('.privacy-status-title', el => el.textContent.trim());
    assert.strictEqual(privacyTitle, 'PRIVACY PROTECTED');

    await sidebarPage.screenshot({ path: path.join(screenshotsDir, 'phase13_privacy.png') });
    console.log('[PASS 5] Screen C captured: Privacy view (phase13_privacy.png)');

    // ── Test Screen D: Settings Modal ──
    await sidebarPage.click('#tabChat');
    await new Promise(r => setTimeout(r, 150));
    await sidebarPage.click('#settingsBtn');
    await new Promise(r => setTimeout(r, 200));

    const settingsModalDisplay = await sidebarPage.$eval('#settingsModal', el => window.getComputedStyle(el).display);
    assert.strictEqual(settingsModalDisplay, 'flex');

    await sidebarPage.screenshot({ path: path.join(screenshotsDir, 'phase13_settings.png') });
    console.log('[PASS 6] Screen D captured: Settings Modal (phase13_settings.png)');

    // Close settings modal
    await sidebarPage.click('#closeSettingsModalBtn');
    await new Promise(r => setTimeout(r, 150));
    const settingsClosed = await sidebarPage.$eval('#settingsModal', el => window.getComputedStyle(el).display);
    assert.strictEqual(settingsClosed, 'none');

    // ── Test Chat State Preservation on Tab Switch ──
    await sidebarPage.type('#userInput', 'Test preservation text');
    await sidebarPage.click('#tabContext');
    await new Promise(r => setTimeout(r, 100));
    await sidebarPage.click('#tabPrivacy');
    await new Promise(r => setTimeout(r, 100));
    await sidebarPage.click('#tabChat');
    await new Promise(r => setTimeout(r, 100));
    const preservedText = await sidebarPage.$eval('#userInput', el => el.value);
    assert.strictEqual(preservedText, 'Test preservation text');
    console.log('[PASS 7] Chat input text preserved across tab switching');

    // ── Test Compact Privacy Badge Click Navigation ──
    await sidebarPage.click('#chatPrivacyBadge');
    await new Promise(r => setTimeout(r, 150));
    const switchedToPrivacy = await sidebarPage.$eval('#privacyView', el => window.getComputedStyle(el).display !== 'none');
    assert.strictEqual(switchedToPrivacy, true);
    console.log('[PASS 8] Compact privacy indicator correctly navigates to Privacy view');

    // ── Responsive Tests: 320px, 360px, 400px, 480px ──
    const widths = [320, 360, 400, 480];
    for (const w of widths) {
      await sidebarPage.setViewport({ width: w, height: 640 });
      await sidebarPage.click('#tabChat');
      await new Promise(r => setTimeout(r, 100));
      const hasHorizontalScroll = await sidebarPage.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      assert.strictEqual(hasHorizontalScroll, false, `Horizontal overflow detected at ${w}px!`);
    }
    console.log('[PASS 9] Verified responsive rendering at 320px, 360px, 400px, 480px (zero horizontal overflow)');

    console.log('\n===============================================================');
    console.log('ALL PHASE 13 REAL-CHROME VISUAL & UX TESTS PASSED!');
    console.log('Screenshots saved in tests/screenshots/');
    console.log('===============================================================');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
