# Vendored Phase 2 runtimes

The `tesseract` directory contains the browser bundle, worker, core WASM variants, and English traineddata required by the lazy OCR loader. The `mediapipe` directory contains the browser/WASM runtime; a compatible face model asset is not bundled yet, so the Vision detector reports an explicit unavailable state until one is added.

These assets are loaded only when the deterministic gate requests visual processing. They are not provider payloads and do not receive API credentials.