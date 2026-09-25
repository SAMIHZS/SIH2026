# SIH26171 — Implementation Log

> **Last updated:** 2026-09-26
> **Status:** Phase 2 Stabilization complete

---

## GROUND TRUTH — WHAT IS ACTUALLY IMPLEMENTED

### Extension Architecture
- **MV3 browser extension** (Chrome Manifest V3, no backend server)
- **Background service worker** (`background.js`) — tab lifecycle, privacy state machine, screenshot capture, offscreen routing, provider gateway
- **Content script** (`content.js`) — page observation, mutation scheduling, lightweight analysis pipeline, visual enrichment trigger, action execution
- **Offscreen document** (`offscreen.html` / `offscreen.js`) — owns the dedicated visual worker (`reason: ['WORKERS']`)
- **Visual worker** (`vision/visualWorker.js`) — runs off-main-thread, MediaPipe face detection + canvas redaction

### Perception Layer
| Detector | File | Status |
|---|---|---|
| DOM detection | `detectors/domDetector.js` | **IMPLEMENTED** |
| Regex / PII detection | `detectors/regexDetector.js` | **IMPLEMENTED** |
| OCR (Tesseract.js) | `detectors/ocrDetector.js` | **IMPLEMENTED** — wired into content.js gate path |
| Face detection (MediaPipe BlazeFace) | `vision/visualWorker.js` + `vision/mediaPipeLoader.js` | **IMPLEMENTED** |
| General visual model | `vision/visualModelStub.js` | **STUB — not implemented** (Phase 3+) |

### Detection Fusion
- `detectionFusion.js` — value-based and spatial overlap merge, max-confidence strategy, full provenance tracking, category normalization via `perceptionSchema.js`

### Perception Schema
- `perceptionSchema.js` — canonical detection shape: `{ source, type, category, confidence, bbox, rect, value, elementId, provenance }`
- `SOURCES`: `dom, regex, ocr, face, visual`
- `CATEGORIES`: privacy (`email, phone, credit_card, password, ssn, account, name_field, sensitive`) + UI (`face, button, input, link, image, icon, canvas_control, visual_control, text_region, embedded_viewer`)

### Privacy / Sanitization
- **Text sanitization** (`sanitize.js`) — PII tokenization to `[EMAIL_1]`, `[PHONE_1]`, etc. Reverse mapping is device-local only. Never crosses network.
- **Image sanitization** (`vision/visualWorker.js`) — OffscreenCanvas redaction. Face: pixelation blur + solid-mask fallback. Text PII regions: solid mask. Raw screenshot never leaves worker unsanitized.
- **Content-script redactor** (`vision/redactor.js`) — legacy in-content Canvas2D redaction (used by `REDACT_SCREENSHOT` handler).

### Privacy State Machine
- Per-tab state: `{ tabId, generation, navigationIdentity, sanitizedContext, screenshot, isValid }`
- `globalGenerationCounter` increments monotonically on tab switch or navigation
- All async results (visual worker, OCR, LLM) are discarded if generation has changed
- **Provider Payload Gate** (`handleBackendRequest`) — 5 sequential invariant checks before any network request:
  1. Active tab match
  2. Generation match
  3. Navigation identity match
  4. Context exists and is marked valid
  5. Screenshot ownership verification + generation-verified screenshot attachment from async enrichment

### Analysis Pipeline (Verified Runtime Flow)
```
PAGE LOAD
  → content.js init → requestAnalysis()
  → DOM detection (domDetector.js)
  → Regex detection (regexDetector.js)
  → Detection fusion (detectionFusion.js)
  → Detection gate (detectionGate.js) → { runOcr, runCv }
  → Lightweight SanitizedContext (sanitize.js) → CONTEXT_READY (background)
  ↓ (async, non-blocking)
  → Visual enrichment (visualPipeline.js → VISUAL_ANALYZE → background.js)
    → chrome.tabs.captureVisibleTab()
    → Offscreen document → visualWorker.js
      → MediaPipe BlazeFace (WASM)
      → Visual model stub (no-op, Phase 3 slot)
      → OffscreenCanvas redaction
      → Sanitized PNG Data URL
    → Merge face detections into fusedDetections
    → Rebuild SanitizedContext with sanitized screenshot
    → CONTEXT_READY (enriched, background)
  OR (when visual pipeline unavailable and gate says runOcr)
  → Legacy OCR (ocrDetector.js via CAPTURE_FOR_ANALYSIS)
    → Tesseract.js WASM → text → regex classification → detections
    → Merge OCR detections, rebuild context, CONTEXT_READY (enriched)
  ↓
USER MESSAGE → sidebar.js → SEND_TO_BACKEND → background.js
  → Provider Payload Gate (5 checks)
  → modelManager.chat(sanitizedContext, userMessage)
    → assertSanitizedContext() (regex scan for PII patterns)
    → geminiProvider/groqProvider/openRouterProvider.chat()
    → Provider API (direct fetch from service worker)
  → Normalized AgentResponse { type, message | action }
  ↓
content.js EXECUTE_ACTION
  → validate.js validateAction()
    → allowlist check: click|type|scroll
    → ElementRegistry.resolve(target, generation)
    → dangerous pattern check
    → visibility check
    → protected element check
  → execute.js executeAction()
```

### Action Security Boundary
- `elementRegistry.js` — opaque stable IDs (`el_1`, `el_2`), WeakMap backing, generation-isolated
- `validate.js` — allowlist `['click', 'type', 'scroll']`, pattern-rejects `eval(`, `javascript:`, etc.
- `execute.js` — plain switch dispatch, no eval, no Function constructor
- `providers/types.js` — normalizes LLM response; throws if action type is not allowlisted

### Provider Architecture
| Provider | Status | Vision |
|---|---|---|
| Gemini | **Functional** | Yes (sanitized screenshot as inline_data) |
| Groq | **Functional** | No (text-only) |
| OpenRouter | **Functional** | No (text-only) |
| Local | **Stub only** | No |

- API keys stored in `chrome.storage.local`
- Provider calls made directly from service worker (no server proxy)
- `modelManager.js` — `assertSanitizedContext()` scans for raw PII patterns before every provider call
- `sanitizeUserMessage()` — strips PII from user's chat message before sending

### Vendor Assets (on-disk)
| Asset | Size |
|---|---|
| MediaPipe WASM (3 variants) | ~34 MB total |
| MediaPipe BlazeFace model | 224 KB |
| MediaPipe vision_bundle.mjs | 152 KB |
| Tesseract WASM (6 variants) | ~68 MB total |
| Tesseract language data (eng, gzipped) | 10.4 MB |
| **Total vendor** | **~88 MB** |

*(Multiple WASM variants exist for SIMD/non-SIMD compatibility — not all are loaded simultaneously)*

---

## WHAT IS PARTIALLY IMPLEMENTED

### Detection Gate
- `detectionGate.js` — `decide()` correctly sets `runOcr` and `runCv` flags
- OCR: **now wired** through content.js (both visual-pipeline-available and fallback paths)
- `runCv` flag: MediaPipe is always run when the visual pipeline is available — the gate's `runCv=false` case currently does not suppress MediaPipe (intentional: face detection is low cost and high privacy value)

---

## WHAT IS NOT IMPLEMENTED (PLANNED)

| Component | Plan |
|---|---|
| General lightweight visual detector | Phase 3 — browser-compatible ViT/UI detector, ONNX Runtime Web, slot in `visualModelStub.js` |
| ONNX Runtime Web | With the visual model (Phase 3) |
| WebGPU execution | With ONNX Runtime Web (Phase 3) |
| Thin server / provider proxy | Phase 4 — move credentials server-side, route through Express |
| MiniLM semantic context | Optional, Phase 5+ |
| OpenCV.js | Explicitly excluded from MVP |

---

## KNOWN LIMITATIONS

1. **No server**: All LLM calls are direct from the extension service worker. API keys are in local storage.
2. **No general visual model**: Only faces are detected in screenshots. UI elements (buttons, icons, canvas controls) are not visually detected.
3. **OCR not tested in production**: `ocrDetector.js` exists and is wired, but full browser runtime testing has not been performed.
4. **Vendor size**: ~88 MB of WASM assets on disk. This is due to multiple SIMD variants of Tesseract — not all are loaded simultaneously.

---

## FILES CHANGED IN THIS PASS

### Created
- `extension/perceptionSchema.js` — canonical detection schema
- `extension/vision/visualModelStub.js` — modular stub for future general visual detector

### Modified
- `extension/content.js` — added `runAsyncVisualEnrichment()` (was missing, caused ReferenceError); fixed OCR/visual pipeline decision logic; improved gate logic
- `extension/detectionFusion.js` — category normalization, provenance tracking, canMerge type check, uses perceptionSchema
- `extension/manifest.json` — added `perceptionSchema.js` to content-script load order and web_accessible_resources
- `extension/background.js` — strengthened Gate 5 (screenshot ownership); added generation-verified screenshot attachment from async enrichment; added [PRIVACY GATE] OK log
- `extension/vision/visualWorker.js` — added visual model stub integration (Step 3b); merged generalVisualDetections into allDetections

### Not Modified
All other files preserved exactly as they were.
