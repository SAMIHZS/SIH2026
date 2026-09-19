# Rules — SIH26171

These are binding implementation rules.

## 1. Privacy Boundary

1. Raw browser information must never be sent directly to remote AI.
2. Only a validated `SanitizedContext` may cross the network boundary.
3. Sanitization happens before the backend call.
4. Backend logs must not intentionally store raw browser content.
5. `alt`, `title`, ARIA labels, form metadata, and other extracted attributes are treated as potentially sensitive.
6. Hidden DOM content is excluded from the context unless a future feature explicitly requires it and defines safe handling.

## 2. Remote AI Restrictions

The remote model may return only the `Action` schema.

Never accept:

- arbitrary JavaScript
- `eval`
- script strings
- shell commands
- unrestricted browser APIs
- arbitrary code execution

## 3. Local Validation

No action executes without local validation.

Validation checks:

1. Action type is allowlisted.
2. Target exists in the current DOM.
3. Target is a valid/expected element for that action.
4. Target is not a protected/sensitive element where the policy forbids interaction.
5. Action parameters are structurally valid.

## 4. Frozen Contracts

Phase 1 freezes:

- `Detection`
- `SanitizedContext`
- `Action`
- `ValidationResult` as an internal result

Changes require team agreement.

New optional fields or enum/source values are preferred over restructuring.

## 5. Architecture Simplicity

Build plain functions and small modules.

Do not create:

- formal plugin registries
- `BrowserAdapter`
- `PerceptionEngine`
- `PolicyEngine` before justified
- detector base classes
- unnecessary provider hierarchies
- empty OCR/CV interface files

The real extensibility mechanism is the stable data shape.

## 6. Phase 1 Detection

Required:

- password
- email
- phone
- card-like number
- account-number-like pattern
- relevant sensitive input attributes

Inspect:

- `type`
- `name`
- `id`
- `placeholder`
- `autocomplete`
- `aria-label`
- associated labels
- visible text
- `alt`
- `title`

Regex is applied to visible/relevant text, not arbitrary hidden HTML.

## 7. Cost-Ordered Detection

Never invoke an expensive detector when a cheaper detector has already resolved the region.

Phase order:

```text
DOM → Regex → OCR → Local CV
```

Local CV must not run on the whole page.

## 8. Networking / MV3

Content scripts do not become the backend networking layer by assuming arbitrary cross-origin fetch behavior.

Use:

```text
Content Script
      ↓
Service Worker
      ↓
FastAPI
```

The service worker owns backend communication and message routing.

## 9. Dynamic Inputs

For React/Vue/controlled inputs, setting `.value` alone may not update application state.

After typing, dispatch appropriate synthetic events, e.g.:

```text
input
change
```

The executor remains restricted to the supported action switch.

## 10. Demo Resilience

Primary backend:

- Groq
- Llama 3.1 8B Instruct

If the live API fails:

```text
Live Groq → timeout/error → deterministic mock Action
```

The fallback must be deterministic and visibly documented as a demo-resilience mechanism, not disguised as live AI.

## 11. Demo Page

Phase 1 uses a custom static page controlled by the team.

It must contain:

- fake name
- fake email
- fake phone
- fake account number
- search input
- search button
- optional sensitive image/metadata test cases

Do not depend on a real third-party website for the core demonstration.

## 12. Security Test Gate

Before every formal demo, verify:

- password cannot appear in network payload
- email cannot appear in network payload
- `alt`/`title` metadata cannot leak PII
- hidden HTML cannot leak PII
- arbitrary JS cannot execute
- invalid selectors cannot execute
- sensitive targets cannot be acted upon improperly
- prompt-injection text is treated as page data, not trusted instructions

## 13. Phase 2 Rules

- OCR is added only through the existing detection pipeline.
- MediaPipe is invoked only on unresolved image/canvas regions.
- Image redaction must preserve correct region coordinates.
- All new detectors emit the existing detection shape.
- Backend output is schema-validated before local execution.

## 14. Phase 3 Rules

- Optimize only after profiling.
- No training/fine-tuning unless the project scope is explicitly re-approved; the baseline plan remains pretrained/off-the-shelf models only.
- No model is adopted solely because it is technically impressive.
- Any advanced security component must have a demonstrated threat or failure mode justifying it.
