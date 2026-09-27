# SIH26171 Privacy-Preserving Browser AI Assistant

## One-Line Description
A privacy-preserving browser AI assistant that performs sensitive visual processing locally, sanitizes context before model transmission, grounds model intents to page-owned elements, and executes only bounded validated browser actions.

---

## Problem
Modern browser agents rely on visual and DOM context to understand web interfaces and perform helpful automation. However:
1. **Severe Privacy Risks**: Browser viewports and page contents frequently contain sensitive personal data—passwords, emails, phone numbers, banking details, medical records, and personal photos. Sending raw screenshots or raw HTML dumps to remote cloud LLMs creates critical data leakage risks.
2. **Unsafe Browser Automation**: Conventional AI agents often request unrestricted control over the browser, executing arbitrary JavaScript, dynamic CSS/XPath selectors, or full browser APIs. If a model hallucinates, misinterprets user intent, or falls victim to prompt injection, it can execute irreversible actions or leak sensitive information.

---

## Solution
SIH26171 solves this by creating a device-local privacy and safety barrier inside Google Chrome (Manifest V3):
- **Local Perception**: Extracts interactive page elements and layout geometry directly within the content script.
- **Local CV & Face Detection**: MediaPipe BlazeFace runs inside an isolated Chrome Offscreen Document to identify and redact human faces.
- **Local OCR**: Tesseract WebAssembly runs inside the Offscreen Document strictly on the redacted canvas to extract bounded text locally.
- **PII Detection & Sanitization**: Sensitive patterns (emails, phone numbers, credit card sequences) are detected locally and replaced with synthetic category tokens (`[EMAIL REDACTED]`).
- **Sanitized Cloud Reasoning**: The remote model receives only sanitized text tokens and locally redacted images (if vision is supported and enabled).
- **ElementRegistry Grounding**: The model never generates direct browser selectors. Instead, its intents are mapped back to DOM elements indexed by the page.
- **Strict Action Validation**: An authoritative action firewall validates that the action type is allowlisted, the target is interactable and non-sensitive, and the generation is fresh.
- **Bounded Multi-Step Execution**: Actions execute with strict limits (max 5 steps, 30-second timeout, re-observation after each step).

---

## What Makes It Different
1. **Local Visual Processing**: CV and OCR run completely client-side via WebAssembly in an Offscreen Document. Raw visual data never touches the cloud.
2. **Privacy-Preserving Context Construction**: High-level semantic context is sanitized before network dispatch; the model reasons over protected abstractions rather than raw personal details.
3. **Generation-Bound Perception**: Perception artifacts are tied to a monotonic generation counter. If a page navigates or changes, stale context is instantly discarded (fail-closed).
4. **Page-Owned Element Registry**: Elements are indexed into `el_1`, `el_2`, etc. The model cannot inject arbitrary CSS selectors, XPath strings, or element references.
5. **Action Firewall**: Only `click`, `type`, and `scroll` are permissible. Dynamic code evaluation (`eval`, `new Function`, `executeScript`) is strictly prohibited.
6. **Bounded Agent Transactions**: Transactions are capped at 5 steps with automatic loop detection (`LOOP_DETECTED`) to prevent runaway automation.
7. **Re-Observation After Every Step**: The agent re-evaluates the page DOM and visual state after each discrete action, verifying actual effects before planning the next step.

---

## Architecture Pipeline
```
PAGE (DOM)
  │
  ▼
DOM PERCEPTION
  │
  ▼
LOCAL CV / OCR (Offscreen Document)
  │
  ▼
PII DETECTION
  │
  ▼
SANITIZATION
  │
  ▼
SANITIZED CONTEXT
  │
  ▼
MODEL PROVIDER (Gemini / Groq / OpenRouter / Local)
  │
  ▼
STRUCTURED INTENT
  │
  ▼
ELEMENT REGISTRY
  │
  ▼
ACTION VALIDATION
  │
  ▼
GENERATION CHECK
  │
  ▼
SAFE EXECUTION (Synthetic Events)
  │
  ▼
RE-OBSERVATION (Fresh state & loop check)
```

---

## Privacy Boundary

### LOCAL (On-Device):
- Viewport capture (`chrome.tabs.captureVisibleTab`)
- Face detection & masking (MediaPipe WebAssembly)
- Optical Character Recognition (Tesseract WebAssembly)
- PII pattern recognition (Regex & DOM detectors)
- Canvas redaction & masking
- Context sanitization & tokenization

### MODEL (Transmitted to Configured Provider):
- Sanitized user prompt
- Sanitized page text context (PII replaced with category tokens)
- Sanitized screenshot (locally redacted PNG, only if vision model is enabled)
- Bounded OCR text extracted from the redacted canvas (<500 characters)

### NEVER TRANSMITTED:
- Raw, unredacted screenshots
- Raw, unredacted OCR output
- Unsanitized PII (passwords, emails, phone numbers)
- Browser cookies, credentials, or session tokens

---

## Safety Boundary
Browser actions are strictly restricted to:
- `click`
- `type`
- `scroll`

The model CANNOT directly execute:
- Arbitrary JavaScript (`eval`, `new Function`, `script` tags)
- Custom CSS selectors or XPath queries
- Arbitrary browser APIs or extension privileges
- Chrome DevTools / debugger commands
- `chrome.tabs.executeScript` or dynamic code evaluation

---

## Multi-Step Agent Guarantees
- **Hard Step Limit**: Maximum 5 steps per transaction.
- **Transaction Timeout**: 30 seconds total elapsed time limit.
- **Single Action Per Step**: Prohibits batch or parallel execution.
- **Fresh Observation**: Mandatory re-observation and DOM settle wait (150ms) after every action.
- **Bounded Retry**: At most one retry for transient execution anomalies.
- **Loop Detection**: Repeated unchanged actions without DOM progression trigger `LOOP_DETECTED`.
- **Navigation Invalidation**: Page changes or navigation instantly abort active transactions as `STALE`.
- **Tab Isolation**: Transactions and cached visual states are partitioned strictly by `tabId`.

---

## Technology Stack
- **Extension Platform**: Google Chrome Manifest V3 (MV3)
- **Programming Language**: Vanilla JavaScript (ES2022) & Web APIs
- **Privileged Runtime**: Chrome Service Worker (`background.js`)
- **Visual Isolation**: Chrome Offscreen Document (`offscreen.html`, `offscreen.js`)
- **Local OCR**: Tesseract.js (WebAssembly + pure client-side worker)
- **Local CV**: MediaPipe BlazeFace (WebAssembly face detection runtime)
- **Credential Storage**: `chrome.storage.local` (privileged extension sandbox)
- **Model Adapters**: Provider abstraction supporting Google Gemini, Groq, OpenRouter, and Local Model
- **Testing & Verification**: Node.js test harness and Puppeteer (Real Chrome MV3 E2E testing)

---

## Testing & Empirical Verification
- **Automated Regression Suite**:
  - `P1–P200`: **200 passed, 0 failed (100% PASS)**
  - Executable via `node tests/run_privacy_tests.js`
- **Real-Chrome Automated Integration Verification**:
  - Phase 5: Local OCR Runtime (`tests/test_phase5_ocr.js` — PASS)
  - Phase 7: Grounding & Actions (`tests/test_phase7_grounding.js` — PASS)
  - Phase 8: Multi-Step Agent Loop (`tests/test_phase8_agent_loop.js` — PASS)
  - Phase 9: Production Hardening (`tests/test_phase9_hardening.js` — PASS)
  - Phase 10: 24-Point Release Candidate (`tests/test_phase10_release.js` — PASS)
- **Real-Chrome Leak Audit (Zero Leaks Verified)**:
  - Raw screenshot leaks: **0**
  - Raw OCR text leaks: **0**
  - API key leaks: **0**
  - Authorization header leaks: **0**
  - Arbitrary action executions: **0**

---

## Installation & Getting Started

### 1. Load Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle on **Developer mode** in the upper right corner.
3. Click **Load unpacked** and select the `extension` folder from this repository.
4. Open the Chrome Side Panel and choose **Privacy Assistant**.

### 2. Configure Model Provider (Optional)
1. Open extension Options (right click extension icon &rarr; **Options**).
2. Select your provider (**Google Gemini**, **Groq**, **OpenRouter**, or **Local Model**).
3. Enter your API key (masked with bullets) and select an available model.
4. Click **Save configuration**.

### 3. Run the Canonical Demo
Open `tests/fixtures/demo_workflow.html` in Chrome.
Trigger the assistant to perform the workflow:
- Step 1: Clicks **Start Workflow**
- Step 2: Clicks **Continue**
- Step 3: Clicks **Complete** &rarr; Workflow Completed.
- Use **Reset Workflow** to repeat deterministically.

---

## Known Limitations
1. **OCR Cold Start**: Initial loading of Tesseract WebAssembly in the Offscreen document takes ~2.9 seconds. Subsequent warm executions complete in ~61 ms.
2. **Local LLM / WebGPU**: On-device LLM reasoning is not included in this release candidate; reasoning is delegated to configured cloud providers over sanitized context.
3. **Action Scope**: Restricted strictly to `click`, `type`, and `scroll`. Complex drag-and-drop or canvas painting is outside the action firewall.
4. **Cross-Origin Iframes**: Interactive elements inside cross-origin iframes are protected by browser security policy and not automated in this build.
5. **Client-Side Key Storage**: API keys are stored in `chrome.storage.local`. They are protected from web content but accessible to the local OS user controlling the browser profile.
6. **Cloud Model Context**: Cloud providers receive sanitized text and redacted imagery. Complete air-gapped isolation requires an on-device model.
