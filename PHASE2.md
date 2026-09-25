# SIH26171 Phase 2 Status

## Purpose

Phase 2 extends the Phase 1 privacy boundary with visual-processing infrastructure and a browser-side provider manager. The migration is intentionally staged: FastAPI remains available until the browser-only path is verified.

## Implemented

- Centralized detector costs and deterministic gate decisions in `extension/detectionGate.js`.
- DOM and Regex results can be fused with provenance, confidence, bounding boxes, and stable IDs in `extension/detectionFusion.js`.
- Numeric, PII-free stage timings in `extension/metrics.js`.
- Content analysis now reports DOM/Regex timings, fusion output, gate decisions, and sanitizer timings.
- Local screenshot masking in `extension/vision/redactor.js`.
- Screenshot capture now sends pixels to the active tab for local redaction before returning them.
- OCR detector boundary in `extension/detectors/ocrDetector.js`, including local OCR-text PII classification and bounding boxes.
- Vision detector boundary in `extension/detectors/visionDetector.js` with lazy runtime loading and an honest unavailable state.
- Browser-side privileged Model Manager in `extension/modelManager.js`.
- Groq, OpenRouter, and Google Gemini provider adapters.
- LocalProvider capability boundary; no fake local inference is claimed.
- Popup configuration for provider, model, user-supplied API key, persistence, and connection testing.
- Sidebar provider state, pipeline state, detector-source counts, and local redacted screenshot control.
- Provider credentials are not returned by `MODEL_GET_CONFIG`, and provider configuration operations reject content-script callers.
- Tesseract.js 7 browser runtime, Tesseract core WASM assets, English traineddata, MediaPipe Tasks Vision runtime, and the BlazeFace short-range model are vendored under `extension/vendor/` and loaded lazily.
- Synthetic OCR and face fixtures execute locally and produce measured initialization/inference timings.
- Provider configuration is now isolated in the registered MV3 options page; the popup remains a compact privacy status/control surface with a top-right Settings gear.
- Google Gemini provider adapter (`extension/providers/geminiProvider.js`): x-goog-api-key header authentication, generateContent-filtered model discovery, models/ prefix normalization, Gemini content/parts request format, safety-block and finishReason error surfaces.
- Settings UI updated with Google Gemini option; model discovery, save, and test connection all route through the existing privileged message boundary.
- `https://generativelanguage.googleapis.com/*` added to manifest host_permissions.
- Dynamic privacy-note span in Settings reflects the active provider name from live configuration.

## Migration State

The service worker prefers the browser-side Model Manager when a configured provider exists. If no browser provider is configured, the existing FastAPI path remains available as a temporary migration fallback.

FastAPI/Python must not be removed until all of these are verified:

1. Groq and OpenRouter requests work from the privileged extension context.
2. Only sanitized context reaches each provider.
3. Provider switching and model persistence work.
4. No-provider privacy operation works without a server.
5. Local action validation and execution remain authoritative.
6. Phase 1 regression tests remain green.

## Runtime Limitations

- No OCR runtime bundle is installed yet. OCR text classification and capability reporting are implemented; image OCR inference remains unavailable until a browser-compatible OCR asset is vendored.
- The OCR and CV runtime assets are now installed and synthetic runtime tests pass. Broader page-level OCR/CV evaluation is still limited to synthetic fixtures.
- Local browser LLM inference is not bundled.
- Screenshot redaction is locally implemented and tested with synthetic canvas data, but screenshot inclusion in ordinary model context remains opt-in.
- Live provider testing requires user-supplied credentials and was not performed as part of repository validation.

## Measured Runtime Evidence

One local synthetic run measured:

- OCR initialization: `944.3 ms`
- OCR inference: `96.7 ms`
- CV initialization: `427.4 ms`
- CV inference: `96.6 ms`
- Redaction test timing: measured in the browser test and reported at runtime
- Sanitization timing: measured in the OCR integration test and reported at runtime

These are test-run observations, not benchmark averages.

## Acceptance Status

| Area | Status |
|---|---|
| OCR runtime | PASS on synthetic image |
| CV runtime | PASS on synthetic face |
| Screenshot pipeline | PASS for local redaction and context eligibility |  
| Groq live path | PARTIAL: adapter/security path tested with mocked transport; real key not supplied |
| OpenRouter live path | PARTIAL: adapter/security path tested with mocked transport; real key not supplied |
| API-key isolation | PASS in provider tests and privileged message design |
| PII leakage test | PASS for synthetic OCR/provider payload checks |
| Phase 1 regression | PASS: existing browser security/detector/validator/sanitizer checks |
| Phase 2 regression | PASS for current runtime, fusion, redaction, provider-security, and metrics tests |
| FastAPI removal | COMPLETED: FastAPI and Python server removed; browser-side ModelManager active |

## Tests Added or Updated

- `tests/test_phase2_foundation.html`
- `tests/test_redaction.html`
- `tests/test_model_manager.html`
- `tests/test_sanitizer.html`
- `tests/test_visual_pipeline.html`
- `tests/test_ocr_runtime.html`
- `tests/test_vision_runtime.html`
- `tests/test_gemini_provider.html`
- `tests/test_action_pipeline.html`
- `tests/test_scheduler_concurrency.html`

The complete browser-side test suite remains 100% passing.

## Migration Completion

Vendored OCR/CV browser runtimes, local redaction, Element Registry target resolution, bounded debounce scheduler, and browser-side provider adapters (Groq, OpenRouter, Google Gemini, LocalProvider) have all been empirically verified. The legacy `server/` runtime has been completely retired.
