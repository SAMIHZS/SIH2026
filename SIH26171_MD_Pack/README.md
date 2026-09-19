# SIH26171 Implementation Pack

This folder is the working documentation baseline for SIH26171.

## Start Here

Read in this order:

1. `PRD.md`
2. `Rules.md`
3. `Schema.md`
4. `Architecture.md`
5. `Design.md`
6. `TechSpecs.md`
7. `Workflow.md`
8. `implementationplan.md`
9. `Tracker.md`

`Phase_Plan.md` is the consolidated Phase 1–3 roadmap.

## Day 1 Command

Before feature code:

```text
1. Open Schema.md
2. Freeze Detection
3. Freeze SanitizedContext
4. Freeze Action
5. Confirm ValidationResult is internal
6. Create Git repo/branches
7. Assign Day 1 tasks
8. Start implementation
```

## Current Core Decision

```text
Browser
 → local detection/sanitization
 → SanitizedContext
 → FastAPI
 → Groq / Llama 3.1 8B
 → Action
 → local validation
 → browser
```

## Demo Safety

If Groq fails during the demo, use the deterministic mock Action fallback. Never bypass local validation.
