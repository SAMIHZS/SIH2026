# SIH26171 — Implementation Plan

> This is the implementation-tracking document. It does NOT replace the baseline documentation in `SIH26171_MD_Pack/`.

## Current Implementation Objective

Build Phase 1: a working privacy-safe Chrome browser assistant prototype with automatic page observation, local PII detection (DOM + regex), sanitization, redacted screenshots, Groq-powered reasoning, assistant sidebar, and privacy visualization.

## Current Architecture

```
extension/
├── manifest.json          # MV3 manifest
├── content.js             # DOM extraction, detectors, sanitizer, executor
├── background.js          # Service worker: messaging, screenshots, networking
├── popup.html/js/css      # Privacy toggle + settings
├── sidebar.html/js/css    # Assistant sidebar with privacy visualization
├── sanitize.js            # Detection[] → SanitizedContext
├── validate.js            # Action validation (allowlist, target checks)
├── execute.js             # Browser execution (click, type, scroll)
└── detectors/
    ├── domDetector.js     # DOM attribute-based PII detection
    └── regexDetector.js   # Regex-based PII detection

server/
├── app.py                 # FastAPI backend, POST /agent
├── ai_provider.py         # Groq provider (openai/gpt-oss-20b)
└── requirements.txt

demo/
└── index.html             # Controlled demo page with fake PII

tests/
└── test_*.html            # Browser-based test pages
```

## Implementation Phases

1. MV3 skeleton + messaging
2. DOM extraction
3. PII detectors (DOM + regex)
4. Sanitizer
5. Screenshot + redaction
6. Service worker networking
7. FastAPI backend + Groq
8. Action validation + execution
9. Automatic page observation
10. Sidebar UI + privacy visualization
11. Demo page
12. Testing + verification

## Dependencies

### Extension (vanilla JS, no external deps)
- Chrome MV3 APIs (runtime, tabs, sidePanel, storage)

### Backend
- fastapi, uvicorn, httpx, pydantic

## Testing Plan

- PII detection: email, phone, password, card, account, metadata
- Sanitization: no raw PII in output
- Security: network payload clean, no eval/scripts
- Validation: allowlist, target checks, rejection
- Execution: click, type (with events), scroll
- Integration: full end-to-end loop

## Security Plan

- Only SanitizedContext crosses network boundary
- Action allowlist: click, type, scroll
- Local validation before execution
- No eval/new Function/scripts
- Backend never logs raw PII

## Known Risks

| Risk | Mitigation |
|---|---|
| MV3 service worker lifecycle | Stateless design |
| Side Panel API | Fallback consideration |
| Groq API failures | Deterministic mock fallback |
| SPA navigation | MutationObserver + event detection |
| Coordinate alignment | Viewport-aware transformation |

## Approved Deviations from Baseline Documentation

| Deviation | Reason |
|---|---|
| Model: openai/gpt-oss-20b (not Llama 3.1 8B) | Explicit user requirement |
| Text responses + Action | User requires conversational assistant |
| Sidebar as primary UI | User requirement, not popup-based |

## Future Extensibility

- Detection[] contract supports future ocr/cv/face/object/ml
- ai_provider.py boundary allows provider swaps
- Sanitizer is source-agnostic
- Action schema has planned Phase 2 extensions
