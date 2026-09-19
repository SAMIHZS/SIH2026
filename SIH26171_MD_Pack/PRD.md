# PRD — SIH26171: On-device Visual Perception for Lightweight Browser Agents

**Status:** Phase 1–3 implementation baseline
**Problem Statement:** SIH26171
**Team:** Sena, Kaif, Teju, Keerthi, Lakshmi, Sarat, Sami

## 1. Product Goal

Build a privacy-first Chrome browser agent that can understand and act on webpages while ensuring sensitive information is detected and sanitized locally before any context crosses the network boundary.

The central product principle is:

> **Use the cheapest reliable detector first, escalate only when necessary, and never send raw PII to the remote reasoning model.**

## 2. Core Problem

Remote browser agents commonly send page screenshots or raw page content to cloud AI systems. That can expose names, emails, passwords, financial information, and other sensitive data.

SIH26171 requires a different architecture:

```text
Browser
  ↓
Local perception
  ↓
Local PII detection
  ↓
Local sanitization/redaction
  ↓
Privacy boundary
  ↓
Remote reasoning
  ↓
Restricted action
  ↓
Local validation
  ↓
Browser execution
```

## 3. USP — Cost-Ordered Privacy Pipeline

```text
DOM / input attributes
        ↓
Regex on visible text
        ↓
OCR on image/canvas regions
        ↓
Local vision model on unresolved regions
```

A later stage is invoked only when an earlier stage cannot resolve a region.

This targets the judging dimensions of privacy, resource utilization, latency, detection quality, and redaction precision without running expensive models unnecessarily.

## 4. Goals

- Detect defined PII locally.
- Prevent raw PII from crossing the network boundary.
- Produce a deterministic `SanitizedContext`.
- Use remote AI only for reasoning.
- Restrict remote output to a frozen `Action` schema.
- Validate every action locally before execution.
- Add OCR and on-device vision without rewriting downstream contracts.
- Measure recall, precision, redaction precision, latency, CPU/RAM/model cost.
- Produce a reproducible demonstration and implementation.

## 5. Non-Goals

- Training or fine-tuning models.
- Firefox/cross-browser support during Phase 1.
- Arbitrary JavaScript execution.
- General-purpose browser automation.
- Full-page continuous vision inference.
- Heavy class/plugin architecture before multiple real implementations justify it.

## 6. Target Users

- Users wanting browser AI without exposing private information.
- Organizations handling sensitive forms and workflows.
- Privacy-sensitive domains such as finance, healthcare, education, and administration.

## 7. Core User Story

> As a user, I give the browser agent an instruction. The agent understands the page, protects sensitive information locally, asks remote AI only to reason over sanitized context, and executes only a locally validated browser action.

## 8. Phased Scope

### Phase 1 — Internal Hackathon: 3–4 days

Build a deterministic end-to-end MVP:

- Chrome MV3 extension
- DOM extraction
- DOM/input-attribute PII detection
- Regex PII detection
- Local sanitization
- DOM-derived screenshot redaction
- FastAPI backend
- Groq + Llama 3.1 8B Instruct as the primary model
- Hardcoded mock fallback
- `click`, `type`, `scroll`
- Local action validation
- Network-level privacy proof
- Controlled static demo page

### Phase 2 — SIH Portal Shortlisting: now → Sept 28

Turn the MVP into a credible measured prototype:

- Tesseract.js OCR for image/canvas text
- MediaPipe face detector as the first local vision specialist
- Cost-based gating
- Image-region redaction
- Stronger prompt-injection handling
- Backend schema validation, retries and timeouts
- Target/origin checks
- Benchmarking across representative pages
- Real demo where OCR/CV contribute to at least one redaction

### Phase 3 — Post-qualification: Nov/Dec

Optimize based on Phase 2 measurements:

- Diagnose actual bottlenecks first.
- ONNX Runtime Web/WebGPU optimization where justified.
- Quantization and model-load optimization.
- Semantic PII detection if benchmarks show recall gaps.
- More advanced image/document detection if required.
- Broader adversarial testing.
- Policy engine only if simple validation is demonstrably insufficient.
- Expanded action set after security review.

## 9. Evaluation Metrics

Use the official/problem-statement judging dimensions as the evaluation framework:

| Metric | Weight | Measurement |
|---|---:|---|
| Visual-context accuracy | 25% | Correct interpretation/detection of relevant visual UI context |
| PII precision/recall | 20% | Detection quality on labeled test cases |
| Redaction precision | 20% | Whether sensitive regions are fully and correctly covered |
| Client resource usage | 20% | CPU/RAM/GPU/model size/load cost |
| Latency | 15% | Capture → detect → sanitize → network → action |

Do not invent benchmark numbers before measuring them.

## 10. Definition of Success

Phase 1 succeeds when the complete pipeline works reliably and the network inspection demonstrates that raw PII is absent.

Phase 2 succeeds when OCR/CV genuinely extend coverage and measured cost-ordered gating is demonstrated.

Phase 3 succeeds when profiling-driven improvements increase robustness, privacy coverage, or performance without compromising the privacy boundary.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Extension API unfamiliarity | Keep architecture flat and learn MV3 first |
| False negatives | Prioritize recall; add detection sources in later phases |
| Prompt injection | Treat webpage content as untrusted data; validate actions locally |
| Network failure | Mock fallback for demo |
| Scope creep | Phase gates; no feature work before core loop |
| Model overhead | Gate OCR/CV and benchmark before adopting |
| Documentation drift | Assign source-of-truth ownership per document |

## 12. Phase Gates

**Phase 1 gate:** end-to-end privacy-safe MVP works.

**Phase 2 gate:** measured OCR/CV extension works and improves coverage.

**Phase 3 gate:** profiling identifies a real limitation before optimization or advanced model work.
