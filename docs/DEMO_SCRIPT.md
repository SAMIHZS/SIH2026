# SIH26171 — 3-Minute Live Presentation & Demo Script

**Speaker Target Duration**: Exactly 3 Minutes (180 Seconds)  
**Presenter Tone**: Professional, technical, factual, and direct.

---

### [0:00 – 0:30] The Real Problem: The Browser Agent Privacy Dilemma

*(Screen shows browser with an open account dashboard displaying personal emails, phone numbers, and profile photos)*

> "Hello judges. Today, browser AI agents are transforming how we interact with the web. But to be useful, these agents need to see the webpage—both its text and its visual layout.
> 
> Here is the critical problem: modern browser viewports contain our most private data—emails, phone numbers, passwords, financial records, and personal photos. Conventional browser agents capture raw screenshots and full DOM dumps, sending them directly to cloud AI servers. This creates severe privacy vulnerabilities. Furthermore, granting AI models unrestricted browser execution privileges introduces risks of prompt injection, rogue automation loops, and irreversible mistakes."

---

### [0:30 – 1:15] The Solution: Dual-Barrier Client Architecture

*(Presenter clicks the Chrome Extension icon to open the Privacy Assistant Side Panel)*

> "Our project, **SIH26171**, eliminates this compromise by implementing a pure client-side Manifest V3 architecture with zero backend servers and zero Python dependencies.
> 
> In our sidebar, you see our active privacy status: **Sensitive visual data is processed locally before model transmission.**
> 
> Let's look at how it works:
> 1. When a page is captured, the raw frame goes directly to an isolated Chrome Offscreen Document.
> 2. MediaPipe detects human faces, and Tesseract WebAssembly runs OCR locally on device.
> 3. Sensitive regions are redacted on a local canvas, and PII patterns like emails and phone numbers are tokenized.
> 
> When we open **What the AI Sees**, you can see the proof: the model receives only high-level category tokens and locally redacted imagery. Raw screenshots, raw OCR strings, and raw DOM trees NEVER cross the network boundary."

---

### [1:15 – 2:10] Live Multi-Step Autonomous Agent

*(Presenter navigates to `demo_workflow.html` and types "Complete this workflow" into the assistant)*

> "Now, let's watch the autonomous agent solve a multi-step task safely.
> 
> I type: *'Complete this workflow.'*
> 
> Watch the execution pipeline:
> - **Step 1**: The agent observes the page locally, grounds the intent to our page-owned `ElementRegistry`, validates the action through our action firewall, and clicks **Start Workflow**.
> - **Step 2**: The page updates to **Continue**. The agent re-observes the fresh DOM state, plans the next step, validates it, and executes.
> - **Step 3**: The page updates to **Complete**. The agent clicks, the page announces *'Workflow completed'*, and the coordinator cleanly concludes.
> 
> Notice what happened:
> Each step was individually grounded to a registered DOM node (`el_1`, `el_2`), validated against our generation counter, executed via synthetic events, and verified through mandatory re-observation. The model was never given direct browser control."

---

### [2:10 – 2:35] Safety Demonstration: Rejecting Unsafe Actions

*(Presenter demonstrates an injected malicious action proposal)*

> "What happens if a prompt injection or a model hallucination attempts an unsafe action?
> 
> Suppose a model proposes an action like `execute_javascript` or tries to inject an arbitrary CSS selector like `div > script`.
> 
> Our Action Firewall instantly intercepts it. The status immediately reports: **REJECTED: Unsupported action type**. The action cannot execute, and the DOM remains completely untouched.
> 
> Immediately afterward, when a valid allowlisted action is proposed, it executes normally. Our firewall proves that the assistant is not unrestricted browser automation."

---

### [2:35 – 3:00] Conclusion & Verified Results

*(Screen displays the 252/252 test results and real Chrome leak audit)*

> "To guarantee our claims, our system has undergone extensive empirical verification:
> - **P1 to P252**: All 252 automated regression tests pass with 0 failures.
> - In live Chrome testing across 24 release candidate checkpoints, our console leak audit measured exactly **zero** screenshot leaks, **zero** OCR text leaks, and **zero** API key exposures.
> - Autonomous 3-step transactions execute in a median of 810 milliseconds.
> 
> Instead of forcing users to choose between useful browser intelligence and data privacy, SIH26171 demonstrates that client-side perception, sanitized cloud reasoning, and validated browser actions provide the standard for safe web agents. Thank you."
