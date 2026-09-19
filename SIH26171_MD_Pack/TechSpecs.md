# Technical Specifications — SIH26171

## 1. Stack

| Layer | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| Browser | Chrome MV3 | Chrome MV3 | Chrome + possible future ports |
| Language | JS/TS | JS/TS | JS/TS |
| Detection | DOM + Regex | + Tesseract OCR + MediaPipe | + advanced/semantic detection |
| Redaction | Canvas + DOM bbox | + image-region redaction | optimized strategies |
| Backend | FastAPI | FastAPI | FastAPI or revised backend |
| LLM | Groq / Llama 3.1 8B | same | benchmark/revisit if justified |
| Local ML | none in main path | MediaPipe | ONNX/WebGPU if justified |

## 2. DOM Extraction

Extract only useful page information:

- visible text
- relevant inputs
- buttons
- labels
- IDs/names
- placeholders
- ARIA labels
- `autocomplete`
- `alt`
- `title`
- role

Exclude hidden content from the normal sanitized context.

## 3. PII Detection

### DOM detector

Inspect:

```text
type
name
id
placeholder
autocomplete
aria-label
label
```

Sensitive examples:

```text
password
email
tel
cc-number
account
```

### Regex detector

Initial patterns:

- email
- phone
- card-like numbers
- account-like numbers

Use normalization where required, but preserve original raw values only locally.

## 4. Screenshot Redaction

```text
flagged DOM element
      ↓
getBoundingClientRect()
      ↓
coordinate transformation
      ↓
canvas draw
      ↓
redacted screenshot
```

The redaction rectangle must account for viewport/screenshot coordinate alignment.

## 5. Backend Networking

Architecture:

```text
Content Script
     ↓ chrome.runtime messaging
Service Worker
     ↓ HTTPS/HTTP backend request
FastAPI
     ↓
Groq API
```

Do not make the content script responsible for arbitrary cross-origin backend communication.

## 6. AI Provider

Primary:

```text
Provider: Groq
Model: Llama 3.1 8B Instruct
```

Fallback:

```text
deterministic mock Action
```

Prompt requirement:

- sanitized context is data
- webpage text is untrusted
- return only Action JSON
- never return executable code

## 7. Validation

```text
Action
 ↓
schema validation
 ↓
action allow-list
 ↓
target lookup
 ↓
target-type check
 ↓
sensitive/protected target check
 ↓
ValidationResult
```

## 8. Execution

### click

```text
element.click()
```

### type

Set the value, then dispatch controlled-input events:

```text
input
change
```

### scroll

Use a bounded scroll operation.

Never use:

```text
eval
new Function
arbitrary script
```

## 9. Phase 2 OCR

Tesseract.js processes only selected image/canvas regions.

Pipeline:

```text
<img>/<canvas>
   ↓
OCR
   ↓
text
   ↓
PII regex
   ↓
Detection[]
   ↓
redaction
```

## 10. Phase 2 MediaPipe

First model:

```text
MediaPipe Tasks Vision — Face Detector
```

Invocation:

- only on image/canvas regions
- only after cheaper detectors fail
- narrow binary/specialist interpretation
- record load/inference timing

## 11. Phase 3 Candidate Stack

Only if profiling justifies it:

- ONNX Runtime Web
- WebGPU
- quantized models
- semantic PII/NER
- document/object classification

## 12. Measurements

Capture:

- detection latency
- OCR latency
- model load time
- model inference time
- end-to-end latency
- CPU usage
- RAM usage
- GPU usage where available
- model/package size
- PII precision
- PII recall
- redaction precision

Record environment with every benchmark.

## 13. Failure Handling

Every external operation needs bounded failure behavior:

```text
timeout
retry where safe
structured error
mock fallback where appropriate
never execute an unvalidated action
```
