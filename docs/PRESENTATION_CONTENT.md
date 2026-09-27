# SIH26171 — Final Submission Slide Deck Content

This document outlines the slide-by-slide structure, visual layouts, bullet points, and speaker notes for the SIH26171 final presentation (10 slides).

---

### SLIDE 1: Title Slide
- **Title**: Privacy-Preserving Browser AI Assistant
- **Subtitle**: Safe Visual Browser Agents Without Exposing Raw Browser Context
- **Team / Submission ID**: SIH26171
- **Platform**: Pure Client-Side Chrome Manifest V3 (Zero Remote Backend / Zero Python)
- **Speaker Notes**: Introduce the project as an engineering solution to the conflict between browser agent capability and user privacy.

---

### SLIDE 2: The Problem: The Browser Agent Privacy Dilemma
- **Visual**: A split screen showing a rich browser interface (with user emails, phone numbers, credit card inputs, and family photos) being sent in raw form to an external cloud server.
- **Key Points**:
  - Web agents require visual layout and text context to navigate dynamic web applications.
  - Viewports frequently display sensitive personal and confidential data (PII, credentials, health/financial records).
  - Streaming raw screenshots or full HTML dumps to cloud LLMs creates critical privacy and compliance violations.
  - Granting models unrestricted browser automation access invites prompt injection exploits and uncontrolled automation loops.
- **Speaker Notes**: Emphasize that current browser agents compromise privacy for capability.

---

### SLIDE 3: The Solution: Dual-Barrier Client Architecture
- **Visual**: Flow diagram illustrating the separation between Local Processing and Cloud Reasoning:
  ```
  LOCAL ON-DEVICE (Offscreen Doc)          CLOUD REASONING
  [ Raw Viewport Capture ]               [ Configured Model ]
            ↓                                     ↑
  [ MediaPipe CV + Tesseract OCR ]        [ Sanitized Context ]
            ↓                                     │
  [ Local Canvas Redaction & PII Masking ]        │
            ↓                                     ↓
  [ ElementRegistry Grounding ] ←────── [ Structured Intent ]
            ↓
  [ Action Firewall & Safe Execution ]
  ```
- **Key Points**:
  - 100% on-device perception: Face detection (MediaPipe) and local OCR (Tesseract.js WebAssembly).
  - Device-local canvas redaction: Sensitive regions masked before any network transit.
  - High-level sanitized context: Cloud AI reasons over category tokens rather than raw personal details.
  - Action firewall: Model commands are strictly bounded to page-registered elements.
- **Speaker Notes**: Highlight that no backend server exists; the browser itself serves as the privacy barrier.

---

### SLIDE 4: Privacy Architecture & Boundaries
- **Visual**: A high-contrast table comparing what stays local versus what reaches the cloud.
- **Key Points**:
  - **Processed Locally**: Screenshot capture, face detection, canvas masking, OCR text extraction, regex PII detection.
  - **Cloud Receives**: Sanitized context tokens, bounded OCR text (<500 chars), locally redacted screenshot (if vision enabled).
  - **Cloud NEVER Receives**: Raw screenshots, unmasked names/emails/phones, passwords, browser credentials, unparsed DOM trees.
  - **Factual Guarantee**: *"Sensitive visual data is processed locally before model transmission."* (No false claims of "100% private").
- **Speaker Notes**: Point out our strict engineering transparency regarding data boundaries.

---

### SLIDE 5: Multimodal Grounding & ElementRegistry
- **Visual**: Illustration of model intent mapping to actual DOM nodes via `ElementRegistry`.
- **Key Points**:
  - The model does NOT generate CSS selectors or XPath expressions.
  - Model proposes high-level semantic intent: `{ type: "click", elementId: "el_1" }`.
  - `ElementRegistry` resolves IDs to verified, interactable DOM elements scoped to the active generation.
  - Prevents selector injection attacks and cross-frame manipulation.
- **Speaker Notes**: Explain how page-owned grounding eliminates selector injection risks.

---

### SLIDE 6: Safe Bounded Multi-Step Agent Loop
- **Visual**: Circular lifecycle diagram of a transaction step.
- **Key Points**:
  - **Lifecycle**: `Observe` &rarr; `Plan` &rarr; `Ground` &rarr; `Validate` &rarr; `Execute` &rarr; `Re-observe`.
  - **Enforced Limits**:
    - Max 5 steps per transaction.
    - 30-second total execution timeout.
    - Exactly one action per step (batch execution prohibited).
    - Mandatory 150ms DOM settle wait before re-observation.
    - Monotonic generation counter invalidates stale actions on navigation.
    - Loop detection halts repeated ineffective actions (`LOOP_DETECTED`).
- **Speaker Notes**: Detail how the agent coordinator enforces deterministic multi-step reliability.

---

### SLIDE 7: Security Audit & Action Firewall
- **Visual**: Matrix of attempted attacks being intercepted by the Action Firewall.
- **Key Points**:
  - `execute_javascript` &rarr; **REJECTED** (`UNSUPPORTED_ACTION_TYPE`)
  - Arbitrary CSS selector injection (`div > script`) &rarr; **REJECTED**
  - Stale generation action &rarr; **REJECTED** (`STALE_GENERATION`)
  - Target inside password input &rarr; **REJECTED** (`PROTECTED_TARGET`)
  - Cross-tab manipulation &rarr; **REJECTED** (`WRONG_TAB`)
  - Actions strictly limited to allowlisted primitives: `click`, `type`, `scroll`.
- **Speaker Notes**: Stress that the assistant is bounded automation, not an unrestricted browser shell.

---

### SLIDE 8: Live Demonstration Workflow
- **Visual**: Screenshots/video of the canonical 3-step demo:
  - Step 1: Grounding & Click on `Start Workflow`
  - Step 2: Re-observation & Click on `Continue`
  - Step 3: Re-observation & Click on `Complete` &rarr; "Workflow completed."
  - Demonstrating safety: Unsafe action rejection followed by valid execution.
  - Demonstrating repeatability: One-click deterministic reset without reloading extension.
- **Speaker Notes**: Summarize the live demo flow demonstrated to the judges.

---

### SLIDE 9: Empirical Results & Verification
- **Visual**: Dashboard of verified benchmarks and leak audit results.
- **Key Points**:
  - **Automated Tests**: P1–P252 (252 passed, 0 failed, 100% PASS).
  - **Real Chrome Leak Audit**:
    - Raw screenshot leaks: **0**
    - Raw OCR text leaks: **0**
    - API key leaks: **0**
    - Authorization header leaks: **0**
    - Arbitrary JS executions: **0**
  - **Execution Latencies**:
    - DOM perception: `1.4 ms` (median)
    - Face detection & canvas redaction: `11.8 ms` (median)
    - Local OCR (warm): `61.2 ms` (median)
    - Complete 3-step multi-step transaction: `~810 ms` (median)
- **Speaker Notes**: Emphasize that all numbers are empirically measured in real Chrome instances.

---

### SLIDE 10: Conclusion & Impact
- **Key Points**:
  - **Practical Privacy**: Sensitive perception happens locally, enabling cloud intelligence without cloud exposure.
  - **Safe Automation**: Strict grounding and action firewalls prevent catastrophic agent failures.
  - **Submission Ready**: Clean Manifest V3 codebase, fully tested, judge-ready, and reproducible.
- **Final Quote**: *"Privacy-preserving browser intelligence through local perception, sanitized reasoning context, and validated browser actions."*
- **Speaker Notes**: Close the presentation, thank the panel, and invite questions.
