# Workflow — SIH26171

## 1. Complete Three-Phase Workflow

```text
User instruction
      ↓
Browser page
      ↓
DOM + screenshot
      ↓
Cost-ordered local perception
      ↓
Detection[]
      ↓
Local sanitization/redaction
      ↓
SanitizedContext
      ↓
NETWORK BOUNDARY
      ↓
FastAPI
      ↓
Groq / Llama 3.1 8B
      ↓
Action
      ↓
Local validation
      ↓
Executor
      ↓
Browser
      ↓
Verification
```

## 2. Phase 1 Workflow

```text
DOM
 ↓
DOM detector + Regex detector
 ↓
Detection[]
 ↓
sanitize()
 ├─ replace sensitive text
 └─ redact screenshot using DOM rectangles
 ↓
SanitizedContext
 ↓
Service Worker
 ↓
FastAPI
 ↓
Groq / mock
 ↓
Action
 ↓
validate()
 ↓
execute()
```

## 3. Phase 1 Demo

1. Open controlled static demo page.
2. Show fake sensitive data.
3. Submit instruction.
4. Extension detects local PII.
5. Show redacted/sanitized context.
6. Open DevTools Network.
7. Show request contains placeholders/safe context, not raw PII.
8. Backend returns structured action.
9. Validator checks target.
10. Browser executes action.

## 4. Phase 2 Workflow

```text
DOM
 ↓
Regex
 ↓
resolved?
 ├─ yes → sanitize
 └─ no
      ↓
    OCR
      ↓
   resolved?
    ├─ yes → sanitize
    └─ no
         ↓
      MediaPipe
         ↓
      sanitize
```

## 5. Phase 2 Security Workflow

```text
webpage content
      ↓
mark as untrusted data
      ↓
sanitized context
      ↓
remote model
      ↓
schema validation
      ↓
local target validation
      ↓
origin/target checks
      ↓
execute or reject
```

## 6. Phase 3 Workflow

```text
Real-page benchmark set
       ↓
Profile bottleneck
       ↓
Choose targeted improvement
       ↓
Implement
       ↓
Benchmark against baseline
       ↓
Security regression tests
       ↓
Adopt only if improvement is demonstrated
```

## 7. Demo Failure Workflow

```text
Groq request
    ↓
success → parse Action
failure
    ↓
deterministic mock
    ↓
validate
    ↓
execute
```

The UI should make the fallback state visible internally/logically; do not claim a mock response is live AI.

## 8. Verification

After execution verify the expected page state.

Examples:

- clicked button changed state
- typed input contains expected safe value
- scroll position changed

Failed verification does not trigger arbitrary retries or arbitrary commands.
