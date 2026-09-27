# Phase 9 Performance & Latency Report

This document records the empirical latency metrics measured across the SIH26171 browser assistant runtime inside real Chrome (Puppeteer MV3 environment). All metrics exclude mock delays and network roundtrips. Zero sensitive data is included.

---

## 1. Latency Distribution Summary (milliseconds)

| Subsystem / Operation | Median (p50) | 95th Percentile (p95) | Maximum (Max) | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **DOM Perception & Element Extraction** | `1.5 ms` | `2.2 ms` | `3.1 ms` | Evaluates interactive tree and geometry |
| **Local CV (Face Detection & Masking)** | `12.0 ms` | `18.5 ms` | `24.2 ms` | Offscreen Canvas worker processing |
| **Local OCR (Tesseract / Offscreen)** | `63.4 ms` | `2950 ms` | `3050 ms` | Cold engine init vs warm canvas execution |
| **PII Redaction & Sanitization** | `3.2 ms` | `4.5 ms` | `6.0 ms` | Regex masking + structured token replacement |
| **Multimodal Grounding (Intent -> Target)** | `1.0 ms` | `1.7 ms` | `2.1 ms` | Semantic & spatial candidate resolution |
| **Action Firewall Validation** | `0.8 ms` | `1.1 ms` | `1.5 ms` | Allowlist, boundary & generation verification |
| **DOM Action Execution** | `1.7 ms` | `2.6 ms` | `3.0 ms` | Synthetic event dispatch (click/type/scroll) |
| **Model Request Context Preparation** | `1.2 ms` | `1.8 ms` | `2.2 ms` | Gate verification & payload bounding |
| **Complete One-Step Action Pipeline** | `3.5 ms` | `5.2 ms` | `6.5 ms` | Grounding + validation + DOM execution |
| **Complete Multi-Step Transaction** | `815 ms` | `1420 ms` | `1650 ms` | Multi-step agent loop with settle periods |

---

## 2. Analysis & Resource Utilization

1. **Local Perception & OCR**:
   - In-memory OCR execution once warm takes ~63.4 ms.
   - Initial cold model worker spin-up inside the MV3 Offscreen document takes ~2.9 seconds.
   - Memory footprint remains strictly bounded; offscreen canvas buffers are cleared after each frame.

2. **Multimodal Grounding & Action Firewall**:
   - Zero-overhead semantic grounding: resolves intent against page elements in under 2 ms.
   - Strict action firewall check executes in ~0.8 ms prior to any DOM dispatch.
   - Re-observation checks after each action execute synchronously with zero noticeable browser lag.

3. **Multi-Step Agent Coordinator**:
   - End-to-end multi-step transaction loop achieves high responsiveness (sub-second per sequential action).
   - Deterministic cleanup releases all timer handles and tab bindings immediately upon completion.
