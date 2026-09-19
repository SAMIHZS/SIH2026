# SIH26171 Privacy Browser Assistant

SIH26171 is a privacy-first Chrome browser assistant that can understand a webpage and perform a small set of validated actions without sending raw personal information to a remote AI model.

## The Idea

Most browser agents send page text, form values, screenshots, or other page context to a cloud model. That creates an unnecessary privacy risk for pages containing email addresses, phone numbers, account identifiers, or other sensitive data.

This project places the privacy boundary on the user's device:

```text
Web page -> local detection -> local sanitization -> SanitizedContext
                                                     |
                                             privacy boundary
                                                     |
                                             FastAPI + AI model
                                                     |
                         validated click/type/scroll action <-
```

The browser performs detection and redaction locally. The backend receives only `SanitizedContext`, never the original page context. The model can return either a text response or one restricted action. Every action is validated locally before it can affect the page.

## Core Principles

- **Local PII protection:** DOM attributes and visible text are inspected in the extension.
- **Sanitized network boundary:** only placeholders such as `[EMAIL_1]` cross the network.
- **Restricted capabilities:** the current action set is `click`, `type`, and `scroll`.
- **Local enforcement:** malformed or unsafe model output is rejected before execution.
- **Demo resilience:** if Groq is unavailable, the backend uses a deterministic mock response.
- **Cost-ordered perception:** DOM and regex detection are the Phase 1 baseline; OCR and vision are planned extensions.

## Repository Layout

```text
extension/              Chrome MV3 extension
  detectors/            DOM and regex PII detectors
  sanitize.js           Local tokenization and sanitization
  validate.js           Action validation
  execute.js            Allowlisted browser action execution
  sidebar.*             Assistant and privacy views
server/                 FastAPI inference boundary
demo/                   Synthetic PII demo page
tests/                  Browser-based detector, sanitizer, validator, and security tests
SIH26171_MD_Pack/       Product, architecture, rules, and implementation documentation
```

## Requirements

- Google Chrome 114 or newer for the Side Panel API
- Python 3.10 or newer
- A Groq API key is optional; without one, the deterministic mock mode is used
- Git is only needed when contributing or updating the repository

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/SAMIHZS/SIH2026.git
cd SIH2026
```

### 2. Create the backend environment

Windows PowerShell:

```powershell
cd server
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

macOS or Linux:

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

### 3. Configure the optional AI provider

Copy `server/.env.example` to `server/.env` and add a Groq key if cloud inference is desired:

```text
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=openai/gpt-oss-20b
```

Never commit `server/.env`. It is excluded by `.gitignore`. Leaving the key unset is supported and activates deterministic fallback responses.

### 4. Start the backend

From the `server` directory, with the virtual environment active:

```bash
python app.py
```

The API listens on `http://127.0.0.1:8000`. Verify it is running:

```text
http://127.0.0.1:8000/health
```

### 5. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension` directory.
5. Pin **SIH26171 Privacy Browser Assistant** if desired.
6. Open the extension popup and select **Open Assistant Sidebar**.

Reload the extension from `chrome://extensions` after changing extension files.

## Running the Demo

Start a simple local web server from the repository root in a second terminal:

```bash
python -m http.server 5500 --directory demo
```

Open `http://127.0.0.1:5500` in Chrome. The demo contains synthetic PII and a search control for testing detection, sanitization, and validated actions. Do not use real personal information in the demo.

## Running the Browser Tests

Serve the repository root:

```bash
python -m http.server 5500
```

Then open these pages in Chrome and inspect the result shown by each test page:

- `http://127.0.0.1:5500/tests/test_detectors.html`
- `http://127.0.0.1:5500/tests/test_sanitizer.html`
- `http://127.0.0.1:5500/tests/test_validator.html`
- `http://127.0.0.1:5500/tests/test_security.html`

## API Overview

### `GET /health`

Returns backend health, whether a Groq key is configured, and the selected model.

### `POST /agent`

Accepts a sanitized context and an optional user message. The response is either:

```json
{
  "type": "text",
  "message": "..."
}
```

or a restricted action:

```json
{
  "type": "action",
  "action": {
    "action": "click",
    "target": "#search-btn",
    "riskLevel": "low"
  }
}
```

The backend validates the response shape, while the extension performs the final local action validation.

## Security Model

The webpage and model output are treated as untrusted data. The model cannot execute JavaScript, shell commands, or arbitrary browser operations. Raw PII is intended to remain on the device, and network inspection is part of the Phase 1 security proof.

For the full contracts, trust boundaries, rules, and phased roadmap, see the documents in [`SIH26171_MD_Pack`](SIH26171_MD_Pack/README.md).

## Current Status

The repository contains the Phase 1 end-to-end MVP: Chrome MV3 extension, local DOM and regex detection, sanitization, FastAPI backend, Groq provider boundary, deterministic fallback, validated actions, demo page, and browser test gates.

Planned Phase 2 work includes OCR, local vision detection, cost-based gating, image-region redaction, stronger prompt-injection handling, and measured benchmarks.

## License

No open-source license has been selected yet. Until one is added, the repository is not automatically licensed for reuse.