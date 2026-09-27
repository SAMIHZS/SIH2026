const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('===============================================================');
console.log('PHASE 10 — RELEASE MANIFEST & DEAD-CODE AUDIT (P156–P160)');
console.log('===============================================================');

const rootDir = path.resolve(__dirname, '..');
const manifestPath = path.join(rootDir, 'extension', 'manifest.json');

assert.ok(fs.existsSync(manifestPath), 'manifest.json exists');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${name}: ${err.message}`);
    failed++;
  }
}

// P156 — manifest is MV3
runTest('P156 — manifest is MV3', () => {
  assert.strictEqual(manifest.manifest_version, 3, 'Manifest version must strictly be 3');
});

// P157 — no obsolete permissions
runTest('P157 — no obsolete permissions', () => {
  const allowedPerms = new Set(['activeTab', 'offscreen', 'sidePanel', 'storage', 'tabs']);
  for (const perm of manifest.permissions) {
    assert.ok(allowedPerms.has(perm), `Permission ${perm} is not in allowed minimal permission set`);
  }
  // Ensure no dangerous or dev permissions
  const forbiddenPerms = ['webRequest', 'webRequestBlocking', 'debugger', 'management', 'proxy', 'nativeMessaging'];
  for (const f of forbiddenPerms) {
    assert.strictEqual(manifest.permissions.includes(f), false, `Forbidden permission found: ${f}`);
  }
});

// P158 — no obsolete script references
runTest('P158 — no obsolete script references', () => {
  // Check background service worker
  const sw = manifest.background?.service_worker;
  assert.ok(sw, 'background.service_worker must be specified');
  assert.ok(fs.existsSync(path.join(rootDir, 'extension', sw)), `Service worker ${sw} must exist`);

  // Check content scripts
  assert.ok(Array.isArray(manifest.content_scripts), 'content_scripts must be defined');
  for (const cs of manifest.content_scripts) {
    for (const jsFile of cs.js) {
      assert.ok(fs.existsSync(path.join(rootDir, 'extension', jsFile)), `Content script ${jsFile} must exist`);
    }
  }
});

// P159 — offscreen configuration valid
runTest('P159 — offscreen configuration valid', () => {
  assert.ok(manifest.permissions.includes('offscreen'), 'permissions must include offscreen');
  const offscreenHtmlPath = path.join(rootDir, 'extension', 'offscreen.html');
  const offscreenJsPath = path.join(rootDir, 'extension', 'offscreen.js');
  assert.ok(fs.existsSync(offscreenHtmlPath), 'offscreen.html must exist');
  assert.ok(fs.existsSync(offscreenJsPath), 'offscreen.js must exist');

  const htmlContent = fs.readFileSync(offscreenHtmlPath, 'utf8');
  assert.ok(htmlContent.includes('offscreen.js'), 'offscreen.html must reference offscreen.js');
});

// P160 — all referenced extension files exist
runTest('P160 — all referenced extension files exist', () => {
  // Check options UI
  if (manifest.options_ui?.page) {
    assert.ok(fs.existsSync(path.join(rootDir, 'extension', manifest.options_ui.page)), `options_ui page ${manifest.options_ui.page} must exist`);
  }

  // Check side panel
  if (manifest.side_panel?.default_path) {
    assert.ok(fs.existsSync(path.join(rootDir, 'extension', manifest.side_panel.default_path)), `side_panel default_path ${manifest.side_panel.default_path} must exist`);
  }

  // Check popup
  if (manifest.action?.default_popup) {
    assert.ok(fs.existsSync(path.join(rootDir, 'extension', manifest.action.default_popup)), `action default_popup ${manifest.action.default_popup} must exist`);
  }

  // Check icons
  if (manifest.icons) {
    for (const [size, iconPath] of Object.entries(manifest.icons)) {
      assert.ok(fs.existsSync(path.join(rootDir, 'extension', iconPath)), `icon ${size} (${iconPath}) must exist`);
    }
  }
});

console.log(`\nManifest Audit Results: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
