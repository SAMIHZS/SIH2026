# SIH26171 Privacy Browser Assistant

SIH26171 is a privacy-first Chrome browser assistant that understands webpages and performs safe, validated browser actions without sending raw personal information or raw visual data to remote AI models.

## The Architecture

Most browser agents transmit raw page text, form values, screenshots, and visual assets directly to cloud LLMs, exposing sensitive personal data (PII). 

SIH26171 enforces an authoritative device-local privacy boundary:

```text
Webpage (DOM)
  ↓
Local Detection (DOM + Regex)
  ↓
Cost-Based Gate
  ↓
Local OCR / CV (Tesseract WASM + MediaPipe BlazeFace, lazily loaded)
  ↓
Detection Fusion (Multi-source grouping & provenance)
  ↓
Local Redaction & Sanitization (Canvas masking + [EMAIL_1] tokenization)
  ↓
SanitizedContext (Strict remote payload isolation)
  ↓
Browser Model Manager (Groq, OpenRouter, Google Gemini, LocalProvider)
  ↓
AgentResponse
  ↓
Local Action Validator
  ↓
Element Registry (Authoritative action-target mapping)
  ↓
Browser Executor (Allowlisted click/type/scroll)
```

The extension executes detection, visual processing, redaction, and action validation entirely in the user's browser. Remote providers receive only tokenized, sanitized text and structural descriptors—never raw PII, never raw screenshots, and never raw OCR output.

## Core Principles

- **Local PII Protection:** DOM attributes and visible text are inspected directly inside the extension.
- **Sanitized Network Boundary:** Only placeholder tokens such as `[EMAIL_1]` and `[PHONE_1]` cross the network.
- **Local Visual Pipeline:** OCR (Tesseract WASM) and face detection (MediaPipe) run 100% locally from vendored extension assets.
- **Direct Local Redaction:** Screenshots are redacted on a device-local canvas before any external transmission.
- **Authoritative Action Targets:** Interactive elements are mapped through a persistent `ElementRegistry` (`el_a_1`, `el_a_2`), preventing arbitrary CSS selector injection.
- **Restricted Capabilities:** Allowed actions are strictly constrained to `click`, `type`, and `scroll`.
- **Credential Isolation:** API keys reside solely in `chrome.storage.local` within privileged service worker contexts.
- **Vanilla MV3:** Zero external runtime dependencies or build steps required.

## Repository Layout

```text
extension/              Chrome MV3 extension (vanilla, build-free)
  background.js         Service worker & message router
  content.js            Content script, scheduler & observation state machine
  detectors/            DOM, Regex, OCR, and Vision detectors
  elementRegistry.js    Authoritative action-target mapping
  execute.js            Allowlisted browser action execution
  modelManager.js       Privileged browser-side model routing
  options.*             Provider configuration UI (Groq, OpenRouter, Gemini)
  popup.*               Quick-access privacy toggle & detection stats
  providers/            Provider adapters (Groq, OpenRouter, Gemini, Local)
  sanitize.js           Local tokenization and sanitization
  sidebar.*             Assistant chat and privacy inspector
  validate.js           Local action security validation
  vendor/               Extension-local runtimes (Tesseract WASM, MediaPipe)
  vision/               MediaPipe loader and canvas screenshot redactor
demo/                   Synthetic PII demo page for testing
tests/                  Automated browser test suites (17 suites)
SIH26171_MD_Pack/       Product, architecture, rules, and technical specifications
```

## Requirements

- Google Chrome 114 or newer (supports Side Panel API and Manifest V3).
- No Python runtime or build step required.
- API keys (optional): Groq, OpenRouter, or Google Gemini can be configured in extension Settings. Without an API key, an offline deterministic fallback is available.

## Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/SAMIHZS/SIH2026.git
cd SIH2026
```

### 2. Load the Chrome Extension

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode** (toggle in top right).
3. Click **Load unpacked**.
4. Select the repository's `extension` directory.
5. Pin **SIH26171 Privacy Browser Assistant** to the Chrome toolbar.

### 3. Configure AI Providers (Optional)

1. Right-click the extension icon and choose **Options** (or click Settings in the popup).
2. Select your preferred provider: **Google Gemini**, **Groq**, or **OpenRouter**.
3. Enter your API key and select a model. Keys are saved locally in `chrome.storage.local`.
4. Click **Test Connection** to verify provider access.

## Running the Demo

Start a local static server from the repository root:

```bash
python -m http.server 8089
```

Open `http://localhost:8089/demo/index.html` in Chrome. Open the extension sidebar to interact with the assistant and observe local PII detection and action execution on synthetic test data.

## Running the Test Suites

With the static server running (`http://localhost:8089`), open any test suite in Chrome:

- `http://localhost:8089/tests/test_action_pipeline.html` — Action pipeline & Element Registry (28 tests)
- `http://localhost:8089/tests/test_visual_pipeline.html` — Visual pipeline, OCR, CV, & provider security (25 tests)
- `http://localhost:8089/tests/test_gemini_provider.html` — Google Gemini provider adapter (12 tests)
- `http://localhost:8089/tests/test_model_manager.html` — Model Manager configuration & routing (10 tests)
- `http://localhost:8089/tests/test_phase2_foundation.html` — Detection gate, fusion, and metrics (9 tests)
- `http://localhost:8089/tests/test_security.html` — Security gate & Rule 12 verification (8 tests)
- `http://localhost:8089/tests/test_ocr_runtime.html` — Local Tesseract WASM runtime (8 tests)
- `http://localhost:8089/tests/test_validator.html` — Action validator security rules (7 tests)
- `http://localhost:8089/tests/test_detectors.html` — DOM & Regex detector unit tests (7 tests)
- `http://localhost:8089/tests/test_scheduler_concurrency.html` — Scheduler concurrency & state machine (7 tests)
- `http://localhost:8089/tests/test_continuous_mutation.html` — Continuous DOM mutation coalescing (5 tests)
- `http://localhost:8089/tests/test_real_page_scheduler.html` — Real-world topology benchmarks (6 tests)
- `http://localhost:8089/tests/test_sanitizer.html` — PII sanitization and token mapping (6 tests)
- `http://localhost:8089/tests/test_provider_security.html` — Provider credential isolation (6 tests)
- `http://localhost:8089/tests/test_vision_runtime.html` — Local MediaPipe face detection runtime (5 tests)
- `http://localhost:8089/tests/test_redaction.html` — Local canvas screenshot redaction (4 tests)
- `http://localhost:8089/tests/e2e_browser_test.html` — Interactive browser action verification (2 tests)

## Security Model

- **Untrusted External Data:** Webpage content and remote model outputs are strictly untrusted.
- **No Remote Code Execution:** The extension rejects `eval()`, `new Function()`, script injection, and arbitrary DOM selectors.
- **Authoritative Resolution:** Model-proposed actions must reference valid, active targets from `ElementRegistry` (`el_a_N`).
- **Complete Visual Isolation:** Raw screenshot pixels and raw OCR text never leave the device.

For full architecture specs and developer rules, see [`SIH26171_MD_Pack/`](SIH26171_MD_Pack/README.md).