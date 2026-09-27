# SIH26171 — Judge-Facing Technical Summary

## 1. Problem
Modern browser agents require rich perceptual context—both visual screenshots and underlying DOM structures—to understand complex web applications and perform automated tasks on behalf of users. However, browser viewports routinely display sensitive, private, or confidential data: personal photos, emails, phone numbers, banking details, passwords, and medical records. 

Transmitting raw visual captures or unparsed DOM dumps to remote cloud-hosted Large Language Models (LLMs) represents a severe privacy vulnerability that violates user confidentiality and data protection standards. Furthermore, granting AI models unrestricted browser control (e.g., executing arbitrary JavaScript, dynamic CSS selectors, or native browser automation APIs) introduces critical safety hazards, including prompt injection exploits, irreversible state mutations, and rogue automation loops.

---

## 2. Existing Gap in Browser Automation
Conventional browser automation frameworks and emerging "AI Web Agents" suffer from two fundamental flaws:
1. **The Privacy Dilemma**: They operate on an all-or-nothing model—either they stream high-resolution, unredacted desktop screenshots directly to cloud providers, or they fail to perceive dynamic visual elements (canvas graphics, styled buttons, modal dialogs).
2. **Unrestricted Action Privileges**: They grant LLMs direct execution access (via Puppeteer, Playwright, or Chrome DevTools Protocol), allowing models to execute arbitrary scripts, arbitrary CSS/XPath selectors, and unvalidated browser commands.

---

## 3. Core Innovation: Dual-Barrier Client Architecture
**SIH26171** resolves this tension by deploying a pure client-side Manifest V3 architecture that enforces two authoritative boundaries:
1. **The Local Privacy Barrier**: Sensitive visual and textual perception occurs 100% on-device before any model interaction. MediaPipe (face detection) and Tesseract.js (OCR) run inside an isolated Chrome Offscreen Document via WebAssembly. PII is tokenized, sensitive visual regions are masked on a local canvas, and only sanitized representations cross the network.
2. **The Authoritative Action Firewall**: The model is completely decoupled from direct browser APIs. The model can only propose structured semantic intents. These intents are resolved against a page-owned `ElementRegistry`, verified by a multi-check Action Firewall, and executed via trusted synthetic events.

---

## 4. Architecture Pipeline

```
PAGE (DOM)
  │
  ▼
DOM PERCEPTION (content.js)
  │
  ▼
LOCAL CV & OCR (Offscreen Document: MediaPipe + Tesseract WASM)
  │
  ▼
PII DETECTION & CANVAS REDACTION
  │
  ▼
SANITIZED CONTEXT (Structured tokens + Redacted screenshot)
  │
  ▼
MODEL PROVIDER (Gemini / Groq / OpenRouter / Local)
  │
  ▼
STRUCTURED INTENT (JSON Action Proposal)
  │
  ▼
ELEMENT REGISTRY & GROUNDING ENGINE
  │
  ▼
ACTION FIREWALL (Allowlist, Generation, Tab, Target Bounds)
  │
  ▼
SAFE SYNTHETIC EXECUTION (click / type / scroll)
  │
  ▼
RE-OBSERVATION & LOOP DETECTION (Fresh state verification)
```

---

## 5. Security & Safety Model

```
RAW WEBPAGE
    ↓
[LOCAL PRIVACY ENGINE]  ── (Faces blurred, PII tokenized, OCR bounded)
    ↓
SANITIZED CONTEXT
    ↓
[REMOTE AI MODEL]       ── (Reasons over sanitized abstractions only)
    ↓
STRUCTURED INTENT       ── (Single allowlisted action: click/type/scroll)
    ↓
[ACTION FIREWALL]       ── (Validates generation, tab, and DOM node)
    ↓
SAFE DOM EXECUTION
```

- **Allowlisted Actions Only**: Restricted strictly to `click`, `type`, and `scroll`.
- **Zero Arbitrary Execution**: No `eval()`, `new Function()`, `javascript:` URLs, or dynamic CSS selectors.
- **Generation Invariants**: Every transaction and action is tied to an authoritative monotonic generation counter; stale actions caused by page navigation or DOM churn are rejected immediately.
- **Bounded Agent Loop**: Hard limits enforced by `agentCoordinator.js`: maximum 5 steps, 30-second timeout, one bounded retry, and mandatory re-observation between steps.

---

## 6. Empirical Verification & Results

The system has undergone rigorous automated testing across both synthetic isolation suites and live Google Chrome instances using Puppeteer:

- **Automated Regression Suite (`P1–P200`)**: **200 passed, 0 failed (100% PASS rate)**.
- **Real Chrome MV3 Verification**: Successfully verified in real Chrome across 5 development phases (Phases 5, 7, 8, 9, and the Phase 10 24-point Release Candidate test).
- **Real-Chrome Leak Audit (Zero Leaks)**:
  - Raw screenshot leaks: **0**
  - Raw OCR text leaks: **0**
  - API key leaks: **0**
  - Authorization header leaks: **0**
  - Arbitrary action executions: **0**
- **Performance Benchmarks**:
  - DOM Perception: `1.4 ms` (median)
  - Local Face Redaction: `11.8 ms` (median)
  - Local OCR Execution: `61.2 ms` (warm canvas median)
  - Action Firewall Check: `0.8 ms` (median)
  - End-to-end 3-step autonomous workflow: `~810 ms` (median)

---

## 7. Transparent Engineering Disclosures & Boundaries
1. **OCR Cold-Start**: Initial WebAssembly binary loading and worker initialization for Tesseract in the Offscreen document requires ~2.9 seconds. Subsequent warm runs execute in ~61 ms.
2. **Action Boundary**: Automation is purposefully restricted to single-frame DOM contexts; cross-origin iframes and raw canvas painting operations are not automated.
3. **Local Credential Storage**: User API keys are stored in `chrome.storage.local`. They are protected against webpage scripts, but are accessible to the local user operating the browser profile.
4. **Cloud Reasoning**: When configured with Gemini, Groq, or OpenRouter, sanitized context is transmitted to the remote provider. Complete air-gapped isolation requires pairing with an on-device local model.
