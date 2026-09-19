# Schema — SIH26171

**Status:** Frozen baseline contracts.

## 1. Detection

```typescript
type Detection = {
  elementId: string;
  type: string;
  value?: string;       // raw value; device-local only
  source: string;       // dom | regex | ocr | cv | face | object | ml
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidence: number;   // 0–1
};
```

Phase 1 sources:

```text
dom
regex
```

Future sources:

```text
ocr
cv
face
object
ml
```

## 2. SanitizedContext

```typescript
type SanitizedContext = {
  page: {
    url: string;
    title: string;
  };
  elements: {
    id: string;
    tag: string;
    role?: string;
    text?: string;       // sanitized only
    label?: string;      // sanitized only
  }[];
  text: string;          // sanitized only
  screenshot?: string;   // redacted screenshot only
};
```

Invariant:

> No raw PII may exist anywhere inside a `SanitizedContext`.

Derivation:

```text
Raw browser context + Detection[]
              ↓
          sanitize()
              ↓
      SanitizedContext
```

## 3. Action

Phase 1:

```typescript
type Action = {
  action: "click" | "type" | "scroll";
  target: string;
  value?: string;
  riskLevel?: string;
};
```

Phase 2 planned extension:

```typescript
type Action = {
  action:
    | "click"
    | "type"
    | "scroll"
    | "select"
    | "navigate";
  target: string;
  value?: string;
  riskLevel?: string;
};
```

`keypress` remains a Phase 3 candidate and requires security review before adoption.

## 4. ValidationResult

Internal only:

```typescript
type ValidationResult = {
  allowed: boolean;
  reason?: string;
};
```

It does not cross the network boundary and therefore is not one of the three network contracts.

## 5. API

```text
POST /agent

Request:
SanitizedContext

Response:
Action
```

The backend must schema-validate model output before returning an executable action.

## 6. Contract Invariants

- No raw PII in `SanitizedContext`.
- No arbitrary commands in `Action`.
- Every action is locally validated.
- Detection source must not affect downstream sanitizer behavior.
- New detectors feed `Detection[]`.
