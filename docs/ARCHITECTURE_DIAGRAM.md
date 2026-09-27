# SIH26171 Architecture Diagram Specification

This document provides a clean structural and visual blueprint of the complete SIH26171 system architecture, explicitly distinguishing between **Device-Local Execution** and **Remote Model Execution**.

---

## 1. System Block Diagram

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              USER / BROWSER INTERACTION                                │
│                                                                                        │
│   [ USER REQUEST ] ─────────────────────────┐                                          │
│                                             ▼                                          │
│                                   ┌──────────────────┐                                 │
│                                   │   BROWSER PAGE   │                                 │
│                                   │   (Active DOM)   │                                 │
│                                   └─────────┬────────┘                                 │
└─────────────────────────────────────────────┼──────────────────────────────────────────┘
                                              │
                      ┌───────────────────────┴────────────────────────┐
                      │                                                │
                      ▼                                                ▼
┌──────────────────────────────────────────────┐ ┌───────────────────────────────────────┐
│     DOM PERCEPTION (content.js)              │ │   SCREENSHOT CAPTURE (background.js)  │
│  - Traverses interactive DOM tree            │ │   - Captures viewport in memory via   │
│  - Extracts bounding boxes & roles           │ │     chrome.tabs.captureVisibleTab()   │
│  - Registers nodes into ElementRegistry      │ │   - Transferred to Offscreen Document │
└──────────────────────┬───────────────────────┘ └─────────────────────┬─────────────────┘
                       │                                               │
                       └───────────────────────┬───────────────────────┘
                                               │
                                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               LOCAL PRIVACY ENGINE (Isolated Offscreen Document Sandbox)               │
│                                                                                        │
│   ┌──────────────────────────┐    ┌─────────────────────────┐    ┌──────────────────┐  │
│   │   MediaPipe BlazeFace    │    │    Canvas Redaction     │    │   Tesseract.js   │  │
│   │    (Face Detection)      │───▶│   (Solid Color Fill     │───▶│    Local OCR     │  │
│   │  Runs 100% via WebAssembly│    │     over Regions)       │    │(Redacted Canvas) │  │
│   └──────────────────────────┘    └─────────────────────────┘    └────────┬─────────┘  │
│                                                                           │            │
│   ┌──────────────────────────────────────────────────────────┐            │            │
│   │  PII Detection & Context Sanitization (content.js)       │◀───────────┘            │
│   │  - Regex & DOM detection (Emails, Phones, Numbers)       │                         │
│   │  - Replaces sensitive data with category tokens          │                         │
│   │  - Bounds OCR string length (<500 chars)                 │                         │
│   └──────────────────────────┬───────────────────────────────┘                         │
└──────────────────────────────┼─────────────────────────────────────────────────────────┘
                               │
                               │  [ STRICT NETWORK BOUNDARY ]
                               │  - Raw screenshots: NEVER TRANSMITTED
                               │  - Raw OCR: NEVER TRANSMITTED
                               │  - Raw PII: NEVER TRANSMITTED
                               │  - Transmits: Sanitized context + Locally redacted image
                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                     REMOTE MODEL PROVIDER (Privileged Service Worker)                  │
│                                                                                        │
│   [ Google Gemini / Groq / OpenRouter / LocalProvider ]                                │
│   - Receives sanitized text tokens & redacted visual artifact                          │
│   - Generates single structured JSON action proposal per step                          │
└──────────────────────────────┬─────────────────────────────────────────────────────────┘
                               │
                               ▼  [ STRUCTURED INTENT PROPOSAL ]
                               │  e.g.: { status: "continue", action: { type: "click", elementId: "el_1" } }
                               │
┌──────────────────────────────┴─────────────────────────────────────────────────────────┐
│                      GROUNDING & EXECUTION ENGINE (content.js)                         │
│                                                                                        │
│   ┌──────────────────────────────────────────────────────────┐                         │
│   │  Grounding Engine & ElementRegistry                      │                         │
│   │  - Resolves elementId to active DOM Node                 │                         │
│   │  - Verifies interactive bounding box and connectivity   │                         │
│   └──────────────────────────┬───────────────────────────────┘                         │
│                              │                                                         │
│                              ▼                                                         │
│   ┌──────────────────────────────────────────────────────────┐                         │
│   │  Action Firewall (validate.js)                           │                         │
│   │  - Allowlist Check: click, type, scroll only             │                         │
│   │  - Generation Check: Target generation == Active page gen│                         │
│   │  - Tab Check: Target tabId == Active tabId               │                         │
│   │  - Target Security: Blocks password fields & extension UI│                         │
│   │  - Selector Injection Check: Blocks raw CSS/XPath        │                         │
│   └──────────────────────────┬───────────────────────────────┘                         │
│                              │                                                         │
│                              ▼                                                         │
│   ┌──────────────────────────────────────────────────────────┐                         │
│   │  Safe Synthetic Executor (execute.js)                    │                         │
│   │  - Dispatches trusted synthetic event sequences          │                         │
│   │  - Triggers 'input' / 'change' for reactive state        │                         │
│   └──────────────────────────┬───────────────────────────────┘                         │
└──────────────────────────────┼─────────────────────────────────────────────────────────┘
                               │
                               ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                            RE-OBSERVATION & COORDINATION                               │
│                                                                                        │
│   ┌──────────────────────────────────────────────────────────┐                         │
│   │  Agent Coordinator (agentCoordinator.js)                 │                         │
│   │  - Observes 150ms DOM settle interval                    │                         │
│   │  - Verifies observable DOM transition                    │                         │
│   │  - Loop detection: repeated identical actions halted     │                         │
│   │  - Enforces step limit (MAX_STEPS = 5) and 30s timeout   │                         │
│   │  - Advances to next step OR terminates with clean state  │                         │
│   └──────────────────────────────────────────────────────────┘                         │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Responsibility Matrix

| Component | Execution Context | Network Privileges | Sensitive Data Access | Key Role |
| :--- | :--- | :--- | :--- | :--- |
| `content.js` | Page Isolated World | None | Reads DOM text | DOM perception, PII tokenization, synthetic event dispatch |
| `elementRegistry.js` | Page Isolated World | None | None | Authoritative mapping of DOM elements to monotonic IDs (`el_1`, `el_2`) |
| `offscreen.js` | Offscreen Document | None | In-memory frame | MediaPipe face detection, canvas redaction, and local Tesseract OCR |
| `background.js` | Service Worker | Model Provider endpoints only | In-memory sanitized artifacts | Capture triggering, provider mediation, key management, generation gating |
| `validate.js` | Page Isolated World | None | None | Action firewall verifying action types, generation freshness, and target nodes |
| `execute.js` | Page Isolated World | None | None | Dispatches trusted synthetic events without dynamic evaluation primitives |
| `agentCoordinator.js` | Service Worker / Sidebar | None | None | Bounded multi-step loop, retry policy, timeout handling, and loop detection |
| `sidebar.js` | Extension Side Panel | None | Sanitized context metadata | User chat interface, privacy indicator, and "What the AI Sees" view |
