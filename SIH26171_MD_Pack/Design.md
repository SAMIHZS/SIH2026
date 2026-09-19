# Design — SIH26171

## 1. Design Philosophy

> Freeze data shapes early. Keep implementations simple. Add abstraction only when real variation requires it.

The project is intentionally not a large OOP framework.

## 2. Two-Zone Trust Model

```text
┌────────────────────────────┐
│ TRUSTED ZONE               │
│ User device                │
│                            │
│ Raw DOM                    │
│ Raw PII                    │
│ Detection                  │
│ Sanitization               │
│ Redaction                  │
└──────────────┬─────────────┘
               │
        SanitizedContext
               │
══════════ PRIVACY BOUNDARY ══════════
               │
┌──────────────▼─────────────┐
│ UNTRUSTED ZONE              │
│ Remote backend / LLM        │
│                            │
│ Sanitized reasoning only    │
└──────────────┬─────────────┘
               │
             Action
               │
               ▼
        Local validation
               │
               ▼
          Browser action
```

## 3. Phase 1 Architecture

```text
extension/
  manifest.json
  content.js
  background.js
  popup.html
  popup.js
  detectors/
    domDetector.js
    regexDetector.js
  sanitize.js
  validate.js
  execute.js

server/
  app.py
  ai_provider.py
```

## 4. Responsibilities

### Content Script

- Read visible DOM.
- Run detectors.
- Collect bounding rectangles.
- Build sanitized context.
- Receive validated execution requests.

### Service Worker

- Route extension messages.
- Capture screenshot when required.
- Send `SanitizedContext` to FastAPI.
- Receive structured `Action`.

### Privacy Layer

- Own raw values.
- Detect PII.
- Replace/mask values.
- Redact screenshot regions.
- Produce final sanitized object.

### Backend

- Accept sanitized context.
- Call Groq/Llama.
- Validate model output.
- Return `Action`.

### Validator

Plain function:

```text
isActionAllowed(action, dom)
```

### Executor

Plain switch:

```text
click
type
scroll
```

## 5. Detection Extensibility

```text
DOM ─────┐
Regex ───┤
OCR ─────┼──→ Detection[] → Sanitizer
CV ──────┤
ML ──────┘
```

Downstream code does not care which detector produced the detection.

## 6. Cost-Ordered Design

```text
cheap / deterministic
       ↓
DOM
       ↓
Regex
       ↓
OCR
       ↓
narrow CV
       ↓
expensive / rare
```

The expensive model is a specialist, not a general browser reasoner.

## 7. Phase 2 Design

Add OCR and local vision as independent detector functions.

Gating:

```text
Image/canvas region
       ↓
DOM/regex resolution?
    yes → stop
    no
       ↓
OCR
       ↓
resolved?
    yes → stop
    no
       ↓
MediaPipe specialist
```

## 8. Phase 3 Design

Use profiling to decide whether to introduce:

- ONNX Runtime Web
- WebGPU
- semantic PII detection
- richer redaction
- policy/threat modules
- expanded action types

No Phase 3 abstraction is considered mandatory until a concrete engineering problem justifies it.
