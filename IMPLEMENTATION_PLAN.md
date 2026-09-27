# SIH26171 — Implementation Plan

> **Status**: All phases complete. This document is retained as a historical implementation record.
> **Current state**: See `README.md` and `RELEASE_VERSION.md` for the verified release snapshot.

---

## Final Architecture (Implemented)

```
extension/
+-- manifest.json               # MV3 manifest
+-- background.js               # Service worker: messaging, screenshots, provider gateway
+-- content.js                  # DOM extraction, detectors, sanitizer, executor
+-- sidebar.html/js/css         # Chrome Side Panel (primary UI)
+-- options.html/js/css         # Provider configuration (MV3 options_ui)
+-- popup.html/js/css           # Toolbar popup (privacy status summary)
+-- elementRegistry.js          # Element ID <-> DOM node mapping (generation-scoped)
+-- grounding.js                # Intent -> DOM resolution
+-- sanitize.js                 # Detection[] -> SanitizedContext
+-- validate.js                 # Action validation (allowlist, target checks, generation)
+-- execute.js                  # Browser execution (click, type, scroll)
+-- agentCoordinator.js         # Bounded multi-step agent loop
+-- modelManager.js             # Provider abstraction + pre-flight PII scan
+-- perceptionSchema.js         # Canonical detection schema
+-- detectionFusion.js          # Multi-source detection merge with provenance
+-- detectionGate.js            # Cost-based gate: decides runOcr / runCv
+-- metrics.js                  # PII-free numeric instrumentation
+-- logger.js                   # Structured logger with key scrubbing
+-- offscreen.html/js           # Isolated Offscreen Document host
+-- detectors/
|   +-- domDetector.js          # DOM attribute-based PII detection
|   +-- regexDetector.js        # Regex-based PII detection
|   +-- ocrDetector.js          # Tesseract OCR gated detector + PII classifier
+-- providers/
|   +-- geminiProvider.js       # Google Gemini adapter (multimodal, vision)
|   +-- groqProvider.js         # Groq adapter
|   +-- openRouterProvider.js   # OpenRouter adapter
|   +-- localProvider.js        # Local model stub
|   +-- types.js                # Provider response normalization
+-- vision/
|   +-- visualPipeline.js       # Screenshot -> offscreen -> enrichment orchestrator
|   +-- visualWorker.js         # Off-main-thread: MediaPipe + canvas redaction
+-- icons/                      # Extension icons (16, 48, 128px)
+-- vendor/                     # Vendored WASM runtimes: Tesseract + MediaPipe (~88 MB)

tests/
+-- run_privacy_tests.js        # P1-P252 Node.js privacy regression suite
+-- test_phase*.js              # Real Chrome Puppeteer integration suites
+-- fixtures/
|   +-- demo_workflow.html      # Canonical 3-step demo page
+-- *.html                      # Browser-native unit test pages
```

---

## Implementation Phases (Historical)

| Phase | Description | Status |
|---|---|---|
| 1 | MV3 skeleton, messaging, DOM extraction, PII detectors, sanitizer | COMPLETE |
| 2 | Visual pipeline (MediaPipe + Tesseract), detection fusion, detection gate, metrics | COMPLETE |
| 3 | Browser-side Model Manager, Gemini/Groq/OpenRouter/Local adapters, options UI | COMPLETE |
| 4 | FastAPI/Python backend removed; browser-only path verified | COMPLETE |
| 5 | OCR runtime wired and verified in real Chrome | COMPLETE |
| 6 | ElementRegistry grounding, Action Firewall, multi-step Agent Coordinator | COMPLETE |
| 7 | Grounding & action validation (Real Chrome verified) | COMPLETE |
| 8 | Multi-step agent loop (Real Chrome verified) | COMPLETE |
| 9 | Production hardening: navigation races, provider failures, loop detection | COMPLETE |
| 10 | Release candidate: 24-point verification suite | COMPLETE |
| 13 | UI/UX design system, sidebar redesign, theme system | COMPLETE |
| 14 | Generation synchronization fix (stale-element recovery) | COMPLETE |

---

## Dependencies

### Extension (no external dependencies)
- Chrome MV3 APIs: `runtime`, `tabs`, `sidePanel`, `storage`, `offscreen`, `scripting`
- Vendored: Tesseract.js v7 (WebAssembly), MediaPipe Tasks Vision (WebAssembly, BlazeFace)

### Backend
- None. The Python/FastAPI server was retired in Phase 4. The extension makes all AI provider
  calls directly from the service worker.

---

## Security Plan (Implemented)

- Only `SanitizedContext` crosses the network boundary
- Action allowlist: `click`, `type`, `scroll` — enforced by `validate.js`
- Local validation before execution with generation freshness check
- No `eval()` / `new Function()` / script tags anywhere in codebase
- Provider never receives raw PII, raw screenshots, or raw OCR text
- API keys stored in `chrome.storage.local`; never logged

---

## Testing (Final State)

- **P1–P252**: 252 privacy regression tests — 100% passing (`node tests/run_privacy_tests.js`)
- **Real Chrome E2E**: Phases 5, 7, 8, 9, 10, 13, 14 — all suites passing
- **Manifest Audit**: P156–P160 passing (`node tests/release_manifest_audit.js`)
- **Zero Leak Audit**: 0 raw screenshot leaks, 0 OCR leaks, 0 API key leaks (verified in real Chrome)
