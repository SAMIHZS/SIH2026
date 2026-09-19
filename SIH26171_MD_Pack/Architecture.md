# Architecture — SIH26171

## 1. System Architecture

```text
                         USER
                          │
                          ▼
                    BROWSER PAGE
                          │
             ┌────────────┴────────────┐
             │                         │
            DOM                    Screenshot
             │                         │
             ▼                         ▼
       DOM / Regex                    Redaction
         Detection                      │
             │                         │
             └────────────┬────────────┘
                          ▼
                      Detection[]
                          │
                          ▼
                     Sanitizer
                          │
                          ▼
                 SanitizedContext
                          │
══════════════════ PRIVACY BOUNDARY ══════════════════
                          │
                          ▼
                     FastAPI
                          │
                          ▼
                 Groq / Llama 3.1 8B
                          │
                          ▼
                       Action
                          │
══════════════════ RETURN TO DEVICE ══════════════════
                          │
                          ▼
                  Schema Validation
                          │
                          ▼
                  Local Validation
                          │
                          ▼
                      Executor
                          │
                          ▼
                    BROWSER PAGE
```

## 2. Phase 1 Modules

```text
extension/
├── manifest.json
├── content.js
├── background.js
├── popup.html
├── popup.js
├── sanitize.js
├── validate.js
├── execute.js
└── detectors/
    ├── domDetector.js
    └── regexDetector.js

server/
├── app.py
└── ai_provider.py
```

## 3. Phase 2 Modules

Add:

```text
detectors/
├── ocrDetector.js
└── visionDetector.js

vision/
├── mediaPipe.js
└── gating.js
```

These remain simple functions/modules unless real implementation multiplicity justifies additional abstraction.

## 4. Phase 3 Candidate Modules

Only when justified:

```text
vision/
  onnxRuntime.js
  webgpu.js

security/
  policy.js
  threatTests.js

detection/
  semanticPII.js
```

## 5. Trust Boundaries

### Trusted

- raw DOM
- raw screenshot
- raw PII
- detector output
- sanitizer
- redactor
- local validator
- executor

### Untrusted

- webpage instructions
- remote LLM output
- remote model reasoning
- network failures
- malformed selectors

The remote model never receives raw PII and never receives authority to execute arbitrary code.

## 6. Core Invariants

```text
Raw PII → device only

Network → SanitizedContext only

Remote AI → Action only

Action → local validation required

Execution → allowlisted browser operation only
```

## 7. Phase Evolution

### Phase 1

```text
DOM + Regex
```

### Phase 2

```text
DOM → Regex → OCR → MediaPipe
```

### Phase 3

```text
DOM → Regex → OCR → specialized ML
                         ↓
                  optimization/security
```

The downstream architecture stays stable because every detection source converges on `Detection[]`.

## 8. Architectural Decision Record

**Decision:** use stable contracts instead of heavy abstraction.

**Reason:** the project has a short timeline and the primary uncertainty is browser/API integration, not implementation polymorphism.

**Consequence:** new capabilities should plug into existing shapes. Abstraction is introduced only when multiple concrete implementations create a real maintenance problem.
