# Terminal Message Rendering Guidance

## Opinion

Canvas-style status messages can use headings and bullets, but terminal status should be compact, linear, and minimally formatted. Prefer three readable lines over a full structured report.

## Before — canvas-style

```md
**Status:** The Meeting canvas is centered on the Meeting Project Architecture artifact, with recent pi-agent output confirming the communication loop works and that no repository edits were made.

**Confidence:** Moderate — the artifact index shows relevant architecture/project-plan artifacts are available, and the pi-agent roundtrip succeeded, but I have not inspected code or run checks in this review.

**Risks / gaps:**
- Current assessment is based on visible meeting context and recent outputs only.
- Implementation status is not verified against repository files or tests.
- Multiple related artifacts exist, so the source of truth may need clarification.

**Recommended next steps:**
1. Confirm which artifact is the active source of truth: architecture vs. project plan.
2. Convert the next concrete project goal into an implementation task.
3. For code work, inspect relevant files, make targeted edits, and run validation checks.
```

## After — terminal-friendly

```txt
Status: Architecture artifact open; pi-agent roundtrip worked. No repo edits/checks.
Confidence: Moderate — based on meeting context only.
Next: Pick source-of-truth artifact, define implementation task, inspect code, run checks.
```

## Terminal template

```txt
Status: <one-line current state>
Confidence: <level> — <short reason>
Next: <1–3 concrete actions>
```
