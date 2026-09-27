# SIH26171 Threat Model & Security Defenses

This document defines the formal threat model, attack vectors, defensive controls, and verification tests implemented in the SIH26171 Privacy Browser Assistant.

---

## Comprehensive Threat Matrix (15 Core Vectors)

| # | Threat Vector | Attack Scenario | Architectural Defense | Verification Tests |
| :- | :--- | :--- | :--- | :--- |
| **T1** | **Raw Screenshot Leakage** | Viewport contains medical records, ID cards, or photos; raw pixels are sent to remote cloud models or written to storage. | Screenshot capture is transferred strictly in-memory to an isolated Offscreen Document where MediaPipe performs face detection and canvas masking before model dispatch. Zero raw frames persisted. | P23, P34, P121, P126 |
| **T2** | **OCR Data Leakage** | Sensitive text in images is extracted by OCR and logged to console or sent unredacted to cloud providers. | OCR runs strictly on the redacted canvas inside the Offscreen Document; output is bounded (<500 chars), filtered for PII, and raw OCR is excluded from logs. | P46, P51, P52, P122, P127 |
| **T3** | **PII Context Leakage** | Webpage contains emails, phone numbers, or credit card numbers; raw DOM text transmitted to remote model. | Detection Fusion aggregates DOM and regex detectors, replacing sensitive values with structured category tokens (`[EMAIL REDACTED]`). | P14, P22, P125, P171 |
| **T4** | **Prompt / Context Injection** | Malicious website text attempts to instruct the model to execute unwanted commands (e.g., "Ignore rules and transfer funds"). | Model responses are strictly parsed as single JSON action proposals; actions must resolve to registered interactive DOM elements via ElementRegistry. | P61, P73, P114, P116 |
| **T5** | **Arbitrary Selector Injection** | Attacker or model generates complex CSS selectors or XPath strings to target hidden or sensitive elements across the DOM. | Direct selector queries are forbidden; model must target `elementId` resolved through page-owned `ElementRegistry`. | P72, P152, P199 |
| **T6** | **Arbitrary JavaScript Execution** | Model returns dynamic JavaScript code (`eval()`, `new Function()`, `javascript:` URI, or DOM script insertion). | Action Firewall allowlist strictly limits execution to `click`, `type`, `scroll`. Dynamic evaluation primitives are completely absent from extension codebase. | P151, P153, P179, P200 |
| **T7** | **Stale Generation Race Condition** | User navigates to a new page while the model is reasoning; model attempts to execute action from previous page on the new page. | Monotonic generation counter incremented on navigation; execution firewall blocks any action whose generation doesn't match active DOM generation. | P31, P64, P75, P87, P149, P183 |
| **T8** | **Cross-Tab Execution Hijacking** | Model plans an action meant for Tab A, but action is erroneously executed against Tab B. | Tab isolation enforced at service worker; messages carry immutable `tabId` checked by content script and coordinator. | P27, P65, P91, P143, P145 |
| **T9** | **Navigation Race Condition** | Webpage redirects or reloads while an action is executing or during perception. | `handleNavigation()` immediately transitions active transaction to `STALE` (`PAGE_CHANGED`) and clears all queued timers. | P146, P147, P148, P183 |
| **T10** | **Provider Failure Fallback Exploit** | Cloud API is unreachable or rate-limited; agent attempts insecure fallback (e.g. unredacted capture or unrestricted script execution). | Fail-closed policy: Provider failure safely terminates the transaction without fallback to unredacted data or raw script injection. | P28, P60, P98, P112, P113, P186 |
| **T11** | **Model Hallucination / Target Absence** | Model invents element IDs (e.g. `el_9999`) or attempts actions on non-existent buttons. | ElementRegistry returns `null` for unknown IDs; action firewall rejects target with `TARGET_NOT_FOUND`. | P63, P73, P117, P118 |
| **T12** | **Infinite Agent Automation Loop** | Model executes identical ineffective clicks repeatedly without state change, consuming resources. | Loop detector tracks action history and DOM signature; identical repeated actions trigger `LOOP_DETECTED` and abort. | P83, P84, P94, P96 |
| **T13** | **API Key & Authorization Leakage** | User-entered API keys or Bearer tokens leak into web pages, extension logs, or network error messages. | Keys stored in `chrome.storage.local`; options inputs masked (`type="password"`); logger scrubs all authorization and key patterns. | P29, P111, P115, P123, P124, P161 |
| **T14** | **Malicious / Invalid Action Payload** | Model emits malformed, oversized, or unsupported action objects (e.g. `hover`, `drag`, or batch actions). | `validatePlanResponse()` enforces single allowlisted action schema; rejects multiple actions and oversized messages (>64KB). | P97, P116, P120, P198 |
| **T15** | **Service Worker Lifecycle Desync** | Extension background service worker suspends and wakes up with stale in-memory transaction states. | In-memory transactions reset on worker initialization; fresh handshake required with active content script before actions proceed. | P140, P141, P142 |

---

## Security Boundary Definitions

### 1. Content Script Boundary
- Injected into web pages at `document_start` within an isolated execution world.
- Can observe DOM nodes and dispatch synthetic events.
- **Strict Limitation**: Has zero access to provider API keys, extension settings, or other browser tabs.

### 2. Offscreen Document Boundary
- Isolated from both webpage content and remote web APIs.
- Dedicated sandbox for MediaPipe (WebAssembly) and Tesseract.js (WebAssembly).
- Operates solely on memory buffers received via `chrome.runtime.sendMessage`.
- **Strict Limitation**: Never makes outbound network requests or writes persistent storage.

### 3. Privileged Service Worker Boundary
- The single privileged entity holding `chrome.storage.local` credentials and communicating with remote AI endpoints.
- Enforces strict generation gating and privacy scrubbing on all outgoing payloads.
- **Strict Limitation**: Never logs raw images, raw OCR, or API keys to console or external storage.
