# SIH26171 Privacy Browser Assistant — Release Checklist

## 1. Architecture
- [x] Manifest V3 strictly enforced (`manifest_version: 3`)
- [x] Zero backend dependencies (no remote server required for execution)
- [x] Zero Python / FastAPI dependencies (pure browser-native extension)
- [x] Local CV face detection and masking in Offscreen Document (MediaPipe)
- [x] Local OCR execution on sanitized canvas in Offscreen Document (Tesseract WASM)
- [x] PII detection and regex sanitization before remote transmission
- [x] Authoritative provider abstraction (Gemini, Groq, OpenRouter, Local)
- [x] Multimodal page grounding to DOM elements via ElementRegistry
- [x] Strict action firewall rejecting arbitrary selectors and unapproved types
- [x] Bounded multi-step agent coordinator (MAX_STEPS = 5, timeout = 30s)

## 2. Privacy Guarantees & Boundaries
- [x] Raw screenshots never logged or written to persistent storage
- [x] Raw OCR text never logged or written to console/diagnostics
- [x] API keys stored in extension storage and never logged or exposed in UI
- [x] Unsanitized DOM or visual context never transmitted to remote models
- [x] Generation isolation: stale visual and DOM context immediately discarded
- [x] Tab lifecycle isolation: tab switch or closure completely destroys associated state
- [x] Factual privacy statements (no "100% private" or false claims)

## 3. Safety & Action Execution
- [x] Allowlisted browser actions only (`click`, `type`, `scroll`)
- [x] No `eval()`, `new Function()`, or arbitrary script execution
- [x] Model-generated CSS selectors and XPath queries strictly rejected
- [x] Stale generation actions blocked by execution firewall
- [x] Navigation during transaction terminates execution immediately with zero mutations
- [x] Single-action per step enforced; batch execution prohibited
- [x] Loop detection triggers `LOOP_DETECTED` on repeated ineffective actions

## 4. Demo Readiness & UX
- [x] Deterministic 3-step demo workflow (Start -> Continue -> Complete) repeatable 5+ times
- [x] Reset mechanism restores initial state without browser restart
- [x] Unsafe action rejection demonstration verified (`execute_javascript` rejected)
- [x] Provider failure and recovery demonstration verified
- [x] Navigation race demonstration verified
- [x] "What the AI Sees" panel displaying category-safe redaction chips only

## 5. UI & Polish
- [x] Dark theme fully supported via CSS variables
- [x] Light theme fully supported via CSS variables
- [x] Responsive layout verified at 360px, 400px, and 480px widths
- [x] Zero horizontal overflow or clipped labels
- [x] Privacy status section prominently displayed in sidebar
- [x] Accessible button names and ARIA role attributes configured

## 6. Testing & Quality Verification
- [x] P1–P200 full privacy regression test suite passing 100% (200/200)
- [x] Real Chrome Puppeteer automated release suite passing 100% (24/24 verification points)
- [x] Zero console leaks across real Chrome execution:
  - Raw screenshot leaks: 0
  - Raw OCR text leaks: 0
  - API key leaks: 0
  - Authorization leaks: 0
  - Arbitrary action executions: 0
- [x] Code syntax verified clean via `node --check`
- [x] Git diff checked and free of whitespace/conflict markers
