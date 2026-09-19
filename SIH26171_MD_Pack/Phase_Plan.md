# SIH26171 — Complete Phase 1–3 Plan

## Timeline

- Phase 1: Internal Hackathon — 3–4 days, 2–4 hrs/day
- Phase 2: SIH Portal Shortlisting — now through Sept 28
- Phase 3: Post-qualification — Nov/Dec

## Phase 1 — Prove

### Goal

Build a deterministic end-to-end privacy-safe browser agent.

### Build

- MV3 extension
- DOM detector
- Regex detector
- Sanitizer
- DOM-bbox screenshot redaction
- FastAPI
- Groq/Llama 3.1 8B
- deterministic mock fallback
- Action validator
- click/type/scroll executor
- static demo page
- DevTools privacy proof

### Do not build

- OCR in main path
- face/object detection in main path
- ONNX/WebGPU
- plugin registries
- PolicyEngine
- arbitrary script execution
- cross-browser support

### Exit

The complete loop works repeatedly:

```text
Observe → Detect → Sanitize → Send safe context
→ Reason → Return Action → Validate → Execute
```

## Phase 2 — Extend and Measure

### Goal

Make the solution credible against the full problem framing.

### OCR

Use Tesseract.js on image/canvas regions.

### Vision

Use MediaPipe Face Detector as the first narrow specialist.

### Gating

```text
DOM → Regex → OCR → Vision
```

Stop when a cheaper method resolves the region.

### Security

- prompt injection
- hidden instructions
- malicious selectors
- origin/target checks
- strict response parsing
- backend timeout/retry
- no raw logging

### Benchmarks

Measure:

- PII precision
- PII recall
- redaction precision
- latency
- CPU
- RAM
- model load
- inference time
- model size

### Exit

OCR and vision genuinely add coverage, gating reduces unnecessary inference, and the benchmark story is defensible.

## Phase 3 — Optimize and Harden

### Goal

Use evidence from Phase 2 rather than adding technology for its own sake.

### Step 1

Benchmark varied pages.

### Step 2

Identify the dominant failure/cost.

### Step 3

Choose targeted improvement.

Possible improvements:

- ONNX Runtime Web
- WebGPU
- quantization
- model caching
- semantic PII
- document detection
- advanced redaction
- stronger policy validation
- expanded actions

### Step 4

Run security regression tests.

### Step 5

Compare against Phase 1 baseline.

### Exit

The final implementation has measurable improvement, preserved privacy guarantees, and an explainable architecture.

## Three-Phase Narrative for Judges

### Phase 1

> We proved the privacy boundary and end-to-end agent loop.

### Phase 2

> We added multimodal perception only where cheaper detectors fail, then measured the cost.

### Phase 3

> We optimized the actual bottleneck and hardened the system using benchmark and adversarial evidence.

## Non-negotiable Throughout All Phases

1. Raw PII does not cross the network boundary.
2. Remote AI cannot execute arbitrary code.
3. Every action is locally validated.
4. Detection sources converge on `Detection[]`.
5. Expensive perception is gated.
6. No training/fine-tuning in the baseline roadmap.
7. Documentation remains synchronized.
