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

