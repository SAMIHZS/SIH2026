# Implementation Plan — SIH26171

## 1. Team

| Role | Owner | Primary responsibility |
|---|---|---|
| Architecture + Integration | Sena | architecture, integration, testing, Git coordination |
| Browser Extension | Kaif | MV3, content script, service worker, DOM, execution |
| Privacy / PII | Teju | DOM/regex detection, detection quality |
| Computer Vision | Keerthi | screenshot, OCR, bbox/redaction |
| On-Device AI | Lakshmi + Sarat | MediaPipe/ONNX, inference, benchmarks |
| Agent + Security Lead | Sami | backend, LLM, contracts, validation, security, demo |

## 2. Phase 1 — 4-Day Sprint

### Day 1 — Foundation

**Whole team, first hour**

Freeze:

- Detection
- SanitizedContext
- Action
- internal ValidationResult

Then:

**Sena**
- MV3 skeleton
- messaging scaffold
- Git/repo setup

**Kaif**
- content script
- DOM traversal
- screenshot proof

**Teju**
- DOM detector
- regex detector

**Keerthi**
- canvas redaction
- coordinate handling
- OCR groundwork only if time

**Lakshmi + Sarat**
- optional standalone MediaPipe proof-of-concept

**Sami**
- FastAPI stub
- mock Action
- validation function
- Groq integration structure

**Day 1 exit criterion:** local DOM → detection → sanitization/redaction pipeline works.

### Day 2 — Privacy + Backend

- Wire detectors.
- Build sanitized DOM/text.
- Add screenshot redaction.
- Send `SanitizedContext` through service worker.
- Backend accepts exact schema.
- Network payload inspected.
- Mock action returns.

**Exit criterion:** sanitized payload reaches backend without raw PII.

### Day 3 — Agent Loop

- Groq/Llama 3.1 8B live call.
- Strict JSON parsing.
- Action validation.
- Executor.
- React/Vue input event handling.
- Demo page finalized.

**Exit criterion:** user instruction → AI → validated action → browser execution.

### Day 4 — Hardening + Demo

No new architecture.

- 10+ repeated runs.
- security tests
- network inspection rehearsal
- error handling
- latency/resource measurement
- PPT
- backup mock path
- final Git tag

**Exit criterion:** repeatable demo without code changes between runs.

## 3. Phase 1 Task Matrix

| Workstream | Owner | Dependency | Output |
|---|---|---|---|
| MV3 | Sena/Kaif | none | extension skeleton |
| DOM | Kaif/Teju | contract | DOM data |
| PII | Teju | contract | Detection[] |
| Redaction | Keerthi | rects | redacted image |
| Backend | Sami | contract | `/agent` |
| LLM | Sami | backend | Action |
| Validation | Sami | Action | ValidationResult |
| Execution | Kaif | validation | browser action |
| Integration | Sena | all | vertical slice |
| Demo | Sami/Sena | all | deterministic demo |

## 4. Phase 2 — Now → Sept 28

### Workstream A — OCR

Owner: Keerthi + Teju

1. Select representative image/canvas cases.
2. OCR only selected regions.
3. Normalize OCR text.
4. Run PII detector.
5. Produce Detection[].
6. Map OCR coordinates to screenshot coordinates.
7. Redact.
8. Benchmark.

### Workstream B — Local Vision

Owner: Lakshmi + Sarat

1. MediaPipe Face Detector.
2. Verify browser runtime.
3. Load-time benchmark.
4. Inference benchmark.
5. Crop-only invocation.
6. Gate behind DOM/regex/OCR.
7. Emit compatible detection result.
8. Integrate.
9. Compare CPU/WASM/WebGPU where available.

### Workstream C — Security

Owner: Sami

- webpage text as untrusted data
- prompt-injection tests
- strict Action schema
- selector validation
- target checks
- origin checks
- malformed model-output handling
- logging review

### Workstream D — Backend

Owner: Sami + Sena

- timeout
- retry where safe
- JSON schema validation
- error states
- model-response normalization
- observability without raw PII

### Workstream E — Integration

Owner: Sena

- merge branches
- regression tests
- end-to-end test matrix
- demo-page variants
- benchmark collection

### Phase 2 exit criteria

- OCR detects at least one image-baked PII case.
- Local vision detects at least one non-text sensitive visual case.
- Cost gating is demonstrable.
- Security tests pass.
- Benchmark table exists.
- Existing contracts remain compatible.

## 5. Phase 3 — Nov/Dec

### Step 1 — Diagnose

Build a benchmark dataset containing:

- standard HTML forms
- image PII
- canvas PII
- faces
- document images
- mixed pages
- adversarial text
- hidden metadata

Measure baseline.

### Step 2 — Identify bottleneck

Choose one primary bottleneck:

```text
recall
precision
redaction
latency
CPU/RAM
model loading
security
```

### Step 3 — Targeted optimization

Possible work:

- ONNX Runtime Web
- WebGPU
- quantization
- model caching
- semantic PII detection
- document classification
- advanced redaction
- stronger policy validation

### Step 4 — Security

Test:

- prompt injection
- hidden instructions
- malicious selectors
- cross-origin target manipulation
- malformed Action
- sensitive-target attempts
- network leakage
- metadata leakage

### Step 5 — Evaluation

Compare Phase 3 against Phase 1 baseline.

Report:

```text
accuracy
PII precision/recall
redaction precision
resource usage
latency
```

### Phase 3 exit criteria

- Every major optimization has benchmark evidence.
- Privacy boundary remains intact.
- Security regression suite passes.
- Model/runtime choices are justified quantitatively.
- Final architecture remains explainable.

## 6. Git Strategy

Branches:

```text
main
dev
feature/<area>
```

Commit by functional milestone, not by tiny generated-code fragments.

Examples:

```text
feat: add DOM detector
feat: add sanitizer
feat: add agent endpoint
feat: add local action validator
test: add privacy leakage cases
```

## 7. Daily Operating Rule

At the beginning of each work session:

1. Pull latest `dev`.
2. Check Tracker.
3. Work only on assigned task.
4. Commit working changes.
5. Report blockers immediately.
6. Update Tracker.
7. Do not silently change frozen contracts.
