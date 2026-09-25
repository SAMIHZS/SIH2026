# SIH26171 — Implementation Log

> Auditable engineering history. Records significant decisions, not trivial coding operations.

---

## Entry 1

- **Date/Time:** 2026-09-07 23:24 IST
- **Discovery/Problem:** Model selection for Phase 1
- **Decision:** Use Groq provider with `openai/gpt-oss-20b` model
- **Reason:** Explicit user requirement overrides baseline docs (which specify Llama 3.1 8B Instruct)
- **Alternatives Considered:** Llama 3.1 8B (baseline docs), Llama 3.3 70B, Mixtral
- **Affected Files:** `server/ai_provider.py`
- **Impact:** Backend provider module configured for openai/gpt-oss-20b; architecture maintains clean provider boundary for future swaps
- **Status:** Approved

---

## Entry 2

- **Date/Time:** 2026-09-07 23:24 IST
- **Discovery/Problem:** API response format — docs specify only Action, but user requires conversational text responses
- **Decision:** Backend returns either a structured Action OR a text response, based on user query intent
- **Reason:** User requirement §4 specifies the assistant should support conversational text interaction, not just actions
- **Alternatives Considered:** (1) Always return Action with a "message" field — overloads schema; (2) Separate /chat endpoint — unnecessary complexity for Phase 1
- **Affected Files:** `server/app.py`, `server/ai_provider.py`, `extension/background.js`, `extension/sidebar.js`
- **Impact:** Response format includes `{ type: "action", action: {...} }` or `{ type: "text", message: "..." }`. Does not modify frozen Action schema itself.
- **Status:** Approved

---

## Entry 3

- **Date/Time:** 2026-09-07 23:24 IST
- **Discovery/Problem:** Primary UI choice — popup vs sidebar
- **Decision:** Use Chrome Side Panel API for sidebar as primary assistant interface. Popup contains only privacy toggle and settings entry.
- **Reason:** User requirement §4 explicitly specifies sidebar for assistant interaction
- **Alternatives Considered:** Popup-only (baseline docs imply this), injected sidebar iframe
- **Affected Files:** `extension/manifest.json`, `extension/sidebar.html`, `extension/sidebar.js`
- **Impact:** Requires `sidePanel` permission in manifest. Chrome 114+ required.
- **Status:** Approved

---

## Entry 4

- **Date/Time:** 2026-09-07 23:24 IST
- **Discovery/Problem:** Dependency selection for backend
- **Decision:** Use FastAPI + uvicorn + httpx + pydantic (no additional deps)
- **Reason:** FastAPI specified in docs. httpx for async Groq calls. Pydantic for schema validation. All mature, well-maintained, MV3-compatible concerns don't apply (backend).
- **Alternatives Considered:** requests (sync, less suitable), aiohttp (less integrated with FastAPI)
- **Affected Files:** `server/requirements.txt`
- **Impact:** Minimal dependency footprint
- **Status:** Approved

---

## Entry 5

- **Date/Time:** 2026-09-07 23:24 IST
- **Discovery/Problem:** Extension architecture — no external JS dependencies
- **Decision:** Use vanilla JavaScript for entire extension (no build tools, no npm, no bundlers)
- **Reason:** MV3 content scripts and service workers work best with plain JS. No complex UI framework needed. Reduces attack surface. Simplifies loading.
- **Alternatives Considered:** Webpack bundler, TypeScript compilation
- **Affected Files:** All extension/*.js files
- **Impact:** All code is direct vanilla JS. No build step required.
- **Status:** Approved

---

## Entry 6

- **Date/Time:** 2026-09-07 23:42 IST
- **Discovery/Problem:** Complete sidebar assistant and visualizer implementation
- **Decision:** Implemented `sidebar.js` with dual tabs (Chat assistant + Privacy View), live context syncing via `GET_LATEST_CONTEXT` and `CONTEXT_UPDATE`, action execution relay to content script (`EXECUTE_ACTION`), and safe token inspection.
- **Reason:** Satisfies User Requirement §4 and Design.md without breaking client-side data isolation.
- **Affected Files:** `extension/sidebar.js`, `extension/icons/`
- **Impact:** Assistant UI fully operational; icons generated for unpacked Chrome loading.
- **Status:** Approved

---

## Entry 7

- **Date/Time:** 2026-09-07 23:43 IST
- **Discovery/Problem:** Backend, Demo page, and Security Test Gate suites
- **Decision:** Completed `server/app.py`, `server/ai_provider.py` (Groq + deterministic mock), `demo/index.html` (synthetic PII & search action target), and browser test suites (`tests/test_detectors.html`, `test_sanitizer.html`, `test_validator.html`, `test_security.html` validating Rule 12).
- **Reason:** Satisfies Rule 10 (Demo Resilience), Rule 11 (Demo Page), and Rule 12 (Security Test Gate).
- **Affected Files:** `server/app.py`, `server/ai_provider.py`, `demo/index.html`, `tests/*`
- **Impact:** Entire Phase 1 milestone fully delivered and auditable.
- **Status:** Approved

---

## Entry 8

- **Date/Time:** 2026-09-23
- **Discovery/Problem:** Begin Phase 2 without creating a partial migration
- **Decision:** Add browser-side gating, fusion, metrics, local redaction, detector capability boundaries, and Model Manager components while retaining FastAPI as a fallback.
- **Reason:** The browser-only path must be verified before removing the working Phase 1 backend.
- **Affected Files:** `extension/metrics.js`, `extension/detectionGate.js`, `extension/detectionFusion.js`, `extension/vision/`, `extension/detectors/ocrDetector.js`, `extension/detectors/visionDetector.js`, `extension/providers/`, `extension/modelManager.js`, `extension/background.js`, `extension/popup.*`, `extension/sidebar.*`, `PHASE2.md`
- **Impact:** Phase 2 foundations are executable; OCR/CV runtime assets and live provider verification remain outstanding.
- **Status:** In progress

---

## Entry 9

- **Date/Time:** 2026-09-23
- **Discovery/Problem:** Phase 2 runtime assets were absent from the initial capability boundaries.
- **Decision:** Vendor Tesseract.js 7 with matching core/language assets and MediaPipe Tasks Vision with the BlazeFace short-range model; load both lazily.
- **Reason:** The no-build extension can run local OCR and narrow face detection without introducing Python or a bundler.
- **Evidence:** Synthetic OCR and face tests pass. Measured sample timings: OCR init 944.3 ms, OCR inference 96.7 ms, CV init 427.4 ms, CV inference 96.6 ms.
- **Remaining limitation:** Real Groq/OpenRouter credentials were not available for live outbound testing; FastAPI remains the fallback.
- **Status:** In progress

---

## Entry 10

- **Date/Time:** 2026-09-23
- **Discovery/Problem:** The popup had become crowded with provider, API-key, model, and connection controls.
- **Decision:** Keep the popup as a lightweight privacy status/control surface and move existing Model Manager configuration into a registered MV3 options page.
- **Reason:** Provider configuration belongs in Settings; the popup should answer whether protection is active and show only compact status.
- **Affected Files:** `extension/popup.html`, `extension/popup.js`, `extension/popup.css`, `extension/options.html`, `extension/options.js`, `extension/options.css`, `extension/manifest.json`, `extension/modelManager.js`
- **Impact:** Settings uses the existing `MODEL_*` messages and storage flow. The popup has an icon-only top-right gear with accessible label/title and no API-key/provider form.
- **Status:** Approved

---

## Entry 11

- **Date/Time:** 2026-09-24
- **Discovery/Problem:** Chrome MV3 extension service workers cannot invoke `new Worker()`. Spawning the visual module worker directly inside `background.js` fails under the service worker environment.
- **Decision:** Implement the MV3-supported Offscreen Document architecture (`content.js` → `background.js` → `offscreen.html`/`offscreen.js` → dedicated `visualWorker.js`).
- **Reason:** Chrome explicitly provides the Offscreen API reason `WORKERS` allowing an offscreen document under the extension's origin to spawn dedicated module workers and dynamically import MediaPipe `vision_bundle.mjs`.
- **Affected Files:** `extension/manifest.json`, `extension/offscreen.html`, `extension/offscreen.js`, `extension/background.js`, `extension/vision/visualWorker.js`, `extension/vision/visualPipeline.js`
- **Impact:** `background.js` manages single-instance offscreen document creation via concurrency locking. Dedicated worker runs entirely off-thread in offscreen context. Zero `new Worker()` calls in `background.js`.
- **Status:** Approved & Verified

---

## Entry 12

- **Date/Time:** 2026-09-24
- **Discovery/Problem:** Stale context across tab switches and same-tab navigations represents a critical privacy failure (cross-page context leakage to remote providers).
- **Decision:** Implement a formal Privacy State Machine enforcing the `(tabId, navigationIdentity, generation)` tuple.
- **Reason:** Remote AI requests must never receive stale page context, stale element IDs, or screenshots belonging to another tab/page generation.
- **Enforcement:**
  1. Synchronous invalidation happens *first* on tab switch or navigation.
  2. Late/superseded async perceptions (DOM, OCR, MediaPipe) are safely discarded.
  3. Fail-closed Provider Payload Gate blocks remote transmission if tab, generation, navigation identity, or screenshot ownership fail to match.
  4. ElementRegistry and action validator enforce generation isolation, rejecting actions on stale element IDs.
- **Evidence:** Verified by test suite (`tests/run_privacy_tests.js` and `tests/test_privacy_invalidation.html`) covering Tests P1 through P6.
- **Status:** Approved & Verified


