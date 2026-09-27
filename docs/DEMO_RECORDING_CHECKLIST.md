# SIH26171 — Demo Video Recording Checklist

This checklist provides a strict protocol for recording the official SIH 3-minute demonstration video to ensure clean presentation, zero data leaks, and high technical quality.

---

### 1. Pre-Recording Preparation

- [ ] **Clean Chrome Profile**: Use a dedicated, pristine Chrome profile with no personal bookmarks, history, or extensions except SIH26171.
- [ ] **Load Unpacked Extension**: Verify `extension/` loads cleanly in `chrome://extensions` with zero errors or warnings.
- [ ] **Sidebar Working**: Open Side Panel and ensure the Privacy Assistant displays `Protected` status with the green indicator.
- [ ] **Provider Configured**: In extension Settings, configure a functional API key for Google Gemini, Groq, or OpenRouter.
- [ ] **API Key Validated**: Click **Test connection** in Options to confirm positive connectivity before recording.
- [ ] **Masking Verified**: Confirm that the API key input is masked with bullets (`••••••••`) and that placeholder reads `Key saved`.
- [ ] **Demo Fixture Ready**: Open `tests/fixtures/demo_workflow.html` locally via `http://localhost:8089/tests/fixtures/demo_workflow.html` or direct file URL.
- [ ] **Reset Fixture Tested**: Click **Reset Workflow** to confirm state resets to `Start Workflow`.
- [ ] **Theme Configured**: Select preferred theme (Dark or Light) for high contrast and visual appeal.
- [ ] **Browser Zoom**: Set browser zoom to exactly **100%** on both the webpage and side panel.
- [ ] **Screen Resolution**: Set recording display to 1080p (1920x1080) or 4K with clean desktop wallpaper.
- [ ] **OS Notifications Muted**: Enable Windows Focus Assist / Do Not Disturb to eliminate notification popups.
- [ ] **No Personal Data Visible**: Close personal browser windows, messaging apps, and system tray items.
- [ ] **DevTools Hidden**: Ensure Chrome Developer Tools are closed during the primary demo flow.

---

### 2. Live Recording Flow (Target: ~3 Minutes)

- [ ] **0:00 – 0:30 (Problem Statement)**:
  - Present active webpage containing personal visual data.
  - State the core privacy risk: conventional agents stream raw screenshots and DOM dumps to cloud LLMs.
- [ ] **0:30 – 1:15 (Privacy Engine & What AI Sees)**:
  - Open Privacy Assistant side panel.
  - Point to **PRIVACY PROTECTED** badge and local processing checklist.
  - Open **What the AI Sees** preview dialog.
  - Highlight that faces are blurred, sensitive categories are tokenized (`[EMAIL REDACTED]`), and only bounded context is generated.
- [ ] **1:15 – 2:10 (Live Multi-Step Agent Execution)**:
  - Submit user prompt: *"Complete this workflow."*
  - Demonstrate real-time grounding: `Start Workflow` &rarr; `Continue` &rarr; `Complete`.
  - Highlight that each action is grounded through `ElementRegistry` and verified by the action firewall.
  - Show final status: `Workflow completed.`.
- [ ] **2:10 – 2:35 (Safety Demonstration)**:
  - Show attempted unsafe action proposal (`execute_javascript`).
  - Demonstrate firewall intercepting it: `REJECTED: Unsupported action type`.
  - Demonstrate subsequent valid click executing smoothly.
- [ ] **2:35 – 3:00 (Conclusion & Results)**:
  - Display empirical results: P1–P200 100% PASS, zero leaks verified in real Chrome.
  - Deliver concluding statement: separating local perception from reasoning creates safe browser intelligence.

---

### 3. Post-Recording Review & Leak Check

- [ ] **Zero API Keys Visible**: Verify video does not expose plaintext API keys in any frame.
- [ ] **Zero Authorization Headers**: Verify network requests or headers are not displayed.
- [ ] **Zero Personal Information**: Confirm no personal emails, family photos, or personal tabs appear.
- [ ] **Zero Raw OCR Dumps**: Ensure "What AI Sees" shows only category badges and bounded metrics.
- [ ] **Audio & Narration Quality**: Verify audio is crisp, balanced, and synced with cursor actions.
- [ ] **Duration Compliance**: Ensure final video duration is under the designated time limit (~3 minutes).
