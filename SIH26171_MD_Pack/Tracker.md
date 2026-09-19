# Tracker — SIH26171

**Source of truth for implementation progress.**

## Phase 1 — Contract Freeze

- [ ] Detection frozen
- [ ] SanitizedContext frozen
- [ ] Action frozen
- [ ] ValidationResult documented
- [ ] All members read Schema.md

## Day 1

- [ ] Sena — MV3 skeleton
- [ ] Sena — message passing
- [ ] Kaif — DOM traversal
- [ ] Kaif — screenshot capture
- [ ] Teju — DOM detector
- [ ] Teju — regex detector
- [ ] Keerthi — redaction function
- [ ] Keerthi — OCR groundwork if time
- [ ] Lakshmi + Sarat — optional MediaPipe POC
- [ ] Sami — FastAPI stub
- [ ] Sami — mock Action
- [ ] Sami — validator

## Day 2

- [ ] Detection pipeline integrated
- [ ] Sanitizer integrated
- [ ] Screenshot redaction integrated
- [ ] Service Worker → backend request
- [ ] Sanitized payload verified
- [ ] Mock Action returned

## Day 3

- [ ] Groq integration
- [ ] Llama 3.1 8B response parsed
- [ ] Action schema validation
- [ ] Local validator
- [ ] Executor
- [ ] Controlled demo page
- [ ] React/Vue input events handled

## Day 4

- [ ] 10+ successful dry runs
- [ ] Security tests pass
- [ ] Network proof rehearsed
- [ ] Demo fallback verified
- [ ] Performance measurements captured
- [ ] PPT complete
- [ ] Final integration complete

## Phase 1 Success Criteria

- [ ] Chrome extension works
- [ ] DOM extraction works
- [ ] DOM PII detection works
- [ ] Regex PII detection works
- [ ] Local sanitization works
- [ ] Screenshot redaction works
- [ ] Only SanitizedContext crosses network
- [ ] Groq or deterministic fallback returns Action
- [ ] Action is locally validated
- [ ] Safe browser execution works
- [ ] Privacy boundary demonstrated

## Phase 2

- [ ] OCR integrated
- [ ] OCR PII detection
- [ ] OCR bbox redaction
- [ ] MediaPipe integrated
- [ ] Cost gating
- [ ] Face redaction demo
- [ ] Security hardening
- [ ] Backend robustness
- [ ] Benchmark suite
- [ ] Phase 2 demo

## Phase 3

- [ ] Baseline benchmark dataset
- [ ] Bottleneck identified
- [ ] Targeted optimization selected
- [ ] ONNX/WebGPU tested if justified
- [ ] Semantic detection tested if justified
- [ ] Advanced security tested
- [ ] Regression suite
- [ ] Final metrics
- [ ] Final documentation

## Status Legend

- Not started
- In progress
- Blocked
- Done

## Documentation Source of Truth

| Content | Owner document |
|---|---|
| Product goals/metrics | PRD.md |
| Binding rules | Rules.md |
| Architecture rationale | Design.md |
| Contracts | Schema.md |
| Technical implementation | TechSpecs.md |
| Data flow | Workflow.md |
| Schedule/ownership | implementationplan.md |
| Progress | Tracker.md |
| System overview | Architecture.md |
