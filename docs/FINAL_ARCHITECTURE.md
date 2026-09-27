# SIH26171 Final System Architecture

## 1. Overview & Core Philosophy

The **SIH26171 Privacy-Preserving Browser AI Assistant** is a pure browser-native extension built on Google Chrome Manifest V3. It executes complex multi-step reasoning and interaction workflows without sacrificing user privacy or granting the AI model unrestricted access to the browser.

### Key Differentiators:
1. **Zero Remote Backend**: No Python, FastAPI, or intermediate cloud servers. All orchestrations, detections, redactions, and actions run inside the client browser.
2. **Local-First Visual Processing**: Sensitive regions (faces, emails, phone numbers, identifiers) are detected and obscured locally using MediaPipe and Tesseract inside an isolated Chrome Offscreen Document.
3. **Strict Action Firewall**: The model cannot execute arbitrary JavaScript, CSS selectors, or unrestricted browser APIs. Actions are strictly grounded to page-registered elements.

---

## 2. End-to-End Pipeline Dataflow

```
PAGE (DOM)
  │
  ▼
[1] DOM PERCEPTION & ELEMENT EXTRACTION
  │  Extracts interactive elements (buttons, inputs, links).
  │  Assigns generation-scoped identifiers (el_1, el_2, ...).
  │
  ▼
[2] SCREENSHOT CAPTURE (Service Worker)
  │  chrome.tabs.captureVisibleTab() captures viewport in memory.
  │
  ▼
[3] OFFSCREEN VISUAL PIPELINE
  │  ├── Face Detection (MediaPipe WebAssembly)
  │  ├── Canvas Redaction (Solid fill over detected sensitive regions)
  │  └── Local OCR (Tesseract WebAssembly executed strictly on redacted canvas)
  │
  ▼
[4] PII DETECTION & CONTEXT SANITIZATION
  │  Perception fusion scans DOM text + bounded OCR text.
  │  Replaces emails, phone numbers, and secrets with synthetic category tokens.
  │
  ▼
[5] GENERATION & TAB BINDING GATE
  │  Verifies active tabId and authoritative generation counter.
  │  Stale or mismatched context is discarded immediately (Fail-Closed).
  │
  ▼
[6] AUTHORITATIVE MODEL ROUTING
  │  Routes sanitized text + sanitized visual artifact to configured provider.
  │  - Vision models (Gemini) receive sanitized image + bounded OCR.
  │  - Text-only models (Groq/OpenRouter) receive zero visual artifacts.
  │
  ▼
[7] STRUCTURED INTENT GENERATION
  │  Model returns single structured JSON action proposal per step.
  │  Format: { status: "continue", action: { type: "click", elementId: "el_1" } }
  │
  ▼
[8] MULTIMODAL GROUNDING & REGISTRY LOOKUP
  │  ElementRegistry resolves model elementId to actual DOM node.
  │  Cross-verifies semantic roles, visible bounding boxes, and generation.
  │
  ▼
[9] ACTION FIREWALL VALIDATION
  │  Verifies:
  │  - Action type allowlisted (click, type, scroll only)
  │  - Generation matches current active DOM generation
  │  - Target node is interactable, visible, and non-disabled
  │  - Target is not protected (e.g., password inputs, extension UI)
  │
  ▼
[10] SAFE DOM EXECUTION
  │  Dispatches trusted synthetic events (focus, mousedown, mouseup, click).
  │  Dispatches 'input' and 'change' events for modern web frameworks.
  │
  ▼
[11] RE-OBSERVATION & LOOP DETECTION
  │  Waits for DOM settle interval (150ms).
  │  Checks for navigation or state changes.
  │  Detects identical repeated actions (LOOP_DETECTED).
  │
  ▼
[12] TRANSACTION COORDINATOR (Next Step or Termination)
  │  Steps count incremented (MAX_STEPS = 5).
  │  Total elapsed time evaluated (MAX_TRANSACTION_TIME_MS = 30000).
```

---

## 3. Core Subsystems

### 3.1 Privileged Service Worker (`background.js`)
- Holds authoritative generation counters (`tabGenerations`) and tab focus state.
- Manages client-side API credentials in `chrome.storage.local`.
- Initiates offscreen visual pipeline and mediates model provider requests.
- Contains zero secret logging; logger automatically scrubs Base64 and keys.

### 3.2 Offscreen Visual Document (`offscreen.html`, `offscreen.js`)
- Runs in dedicated origin isolated from web content.
- Executes MediaPipe face detection and local canvas redactions.
- Executes Tesseract OCR on the redacted canvas only.
- Output text is bounded (max 500 characters, whitespace-normalized) before return.

### 3.3 Content Script & Grounding Engine (`content.js`, `grounding.js`, `elementRegistry.js`)
- Injected at `document_start` on active pages.
- `ElementRegistry` indexes interactive elements with generation tags.
- Model proposals are mapped back to DOM elements via semantic matching or direct registry IDs.
- Arbitrary CSS selectors or DOM script payloads are rejected outright.

### 3.4 Action Firewall & Executor (`validate.js`, `execute.js`)
- Enforces strict allowlist: `click`, `type`, `scroll`.
- Re-verifies generation immediately before synthetic event dispatch to prevent navigation race conditions.
- Never invokes `eval`, `new Function`, or external script injection.

### 3.5 Bounded Multi-Step Agent Coordinator (`agentCoordinator.js`)
- Manages autonomous transactions with hard limits:
  - `MAX_STEPS`: 5 steps.
  - `MAX_TRANSACTION_TIME_MS`: 30 seconds.
  - `PAGE_SETTLE_TIMEOUT_MS`: 3 seconds.
- Automatically handles tab closures, navigation events, and loop detection.

---

## 4. Privacy Boundaries & What Cloud Receives

### What Cloud Receives:
- Sanitized user prompts.
- Synthetically redacted page text context (PII replaced with tokens).
- Locally redacted screenshot image (only if vision model is configured and user enabled screenshot).
- Bounded OCR text extracted from the redacted canvas.

### What Cloud NEVER Receives:
- Raw, unredacted screenshots.
- Unmasked names, emails, phone numbers, or passwords.
- Browser cookies, session tokens, or local credentials.
- Full unparsed DOM trees or proprietary scripts.

---

## 5. End-to-End Execution Walkthrough

To illustrate the concrete pipeline flow for a technical evaluator or judge:

### Step 1: User Request
- **User Prompt**: "Complete this workflow."
- **Current Page**: `Start Workflow` button present on DOM (`demo_workflow.html`).

### Step 2: Local Perception & Redaction
- `content.js` scans interactive nodes and registers the button into `ElementRegistry` as `el_1` under `generation = 1`.
- `background.js` captures viewport in memory and transfers it to the Offscreen Document.
- MediaPipe detects any faces; Tesseract runs on the redacted canvas. PII is tokenized.
- High-level sanitized context package is created.

### Step 3: Model Intent Proposal
- Remote provider receives sanitized context and returns structured intent:
  ```json
  {
    "status": "continue",
    "action": {
      "type": "click",
      "elementId": "el_1",
      "description": "Click the Start Workflow button"
    }
  }
  ```

### Step 4: Grounding & Action Firewall
- `grounding.js` resolves `el_1` to the DOM `<button id="btn-start">`.
- `validate.js` confirms:
  - Allowed action (`click`)
  - Target node is connected, non-disabled, and interactable
  - Action target generation matches active page generation (`gen = 1`)
  - Target is not protected (not a password field)

### Step 5: Safe Synthetic Execution
- `execute.js` dispatches trusted synthetic mouse events (`mousedown`, `mouseup`, `click`).
- The webpage responds, updating the DOM container with the `Continue` button (`<button id="btn-continue">`).

### Step 6: Re-Observation & Iteration
- Agent coordinator observes DOM settle interval (150ms).
- Perception updates: new element registered as `el_2` (`generation = 1`).
- Model plans next step: Click `Continue` (`el_2`).
- Validator approves; executor clicks.

### Step 7: Completion
- Webpage transitions to `Complete` (`<button id="btn-complete">`).
- Step 3 executes; DOM updates to `<div id="workflow-completed-msg">Workflow completed.</div>`.
- Agent re-observes, receives model `status: "done"`, and cleanly transitions sidebar to `Completed`.
- Total transaction runtime: ~810 ms. Active handles and timers are fully freed.

