# Concise Prompt Rendering Guidance

## Position

Pi-agent should see the actual action first. Routing metadata, raw inbox paths, artifact indexes, and repeated handoff boilerplate are useful only as optional provenance; they should not be the rendered prompt the host or Realtime agent reviews.

Preferred rendering is a short `Task / Context / Constraints / Output` block. It preserves intent, source document, hard requirements, and expected delivery without making the wrapper look like the work.

## Current Rendering

```txt
You are pi-agent, the implementation agent for the Meeting app.

Implementation task: Propose concise prompt rendering with before/after examples

Details:
Create a durable artifact that analyzes current rendering of pi-agent questions/instructions versus a preferred concise format. Include before/after examples and a reusable template. Ensure the artifact is selected without wrapper status overriding the view.

Source document: realtime-live-canvas

Work in the current repository and improve the real app so hot reload reflects the change.

Return a concise summary of what changed, verification performed, and any remaining limitations.

## Meeting Handoff Contract

The task prompt above is the Realtime agent's concise handoff summary.
Do not treat raw conversation as part of the prompt by default.
If extra provenance is needed, inspect JSONL records at .../conversation.jsonl.
Answer through Meeting tools/artifacts so the Realtime agent and host can review or speak about the result.
```

What is wrong with this rendering:

- The action is surrounded by role setup and lifecycle instructions.
- The source document is visible, but not connected to the desired output.
- The wrapper contract is longer than the task-specific instruction.
- The UI can later show a `task-result:*` wrapper instead of the artifact body, making the status message look like the result.

## Preferred Rendering

```txt
Task: Propose concise prompt-rendering guidance.
Context: Source document is realtime-live-canvas; current issue is noisy pi-agent question/instruction rendering.
Constraints: Include before/after examples and a reusable template; keep raw JSONL/routing metadata optional; keep the artifact selected over wrapper status.
Output: Durable Meeting artifact opened on the canvas, plus a short implementation summary.
```

Why this works:

- The first line names the action.
- The context line says what existing document or state matters.
- Constraints are explicit and compact.
- Output tells pi-agent where the result belongs.

## Before / After Examples

### Example 1: Full implementation handoff

Before:

```txt
You are pi-agent, the implementation agent for the Meeting app.
Implementation task: Create and open terminal-rendering guidance artifact
Details: Create a durable smart artifact containing the terminal-friendly message rendering guidance...
Source document: realtime-live-canvas
Work in the current repository and improve the real app so hot reload reflects the change.
Return a concise summary of what changed, verification performed, and any remaining limitations.
## Meeting Handoff Contract
...
```

After:

```txt
Task: Create and open terminal-rendering guidance.
Context: Source document is realtime-live-canvas.
Constraints: Include before/after example and template; no raw routing boilerplate in the visible artifact.
Output: Durable artifact selected on the Meeting canvas.
```

### Example 2: Fragmented speech or transcript context

Before:

```txt
raw_user_comm: activity is easy.
raw_agent_comm: Status: Selected the latest terminal rendering guidance artifact...
raw_agent_comm: Realtime agent connected. Available tools: read_meeting_context, read_repo_guide, ...
```

After:

```txt
Task: Clarify whether the current artifact is easy to review.
Context: Recent discussion is about prompt rendering noise and canvas focus.
Constraints: Use transcript fragments only as provenance; do not turn them into the task.
Output: Short review note or focused artifact update.
```

### Example 3: Wrapper status after artifact creation

Before:

```txt
# Propose concise prompt rendering with before/after examples

## Outcome
Completed successfully.

## Pi Agent Summary
Created artifact at artifacts/.../note-concise-prompt-rendering-guidance/artifact.smart.md

Artifact path: `artifacts/.../artifact.smart.md`
```

After:

```txt
Status: Artifact created and selected.
Confidence: High - artifact body is the active canvas document.
Next: Review the concise examples and template.
```

The status belongs in the feed. The artifact body belongs on the canvas.

## Reusable Template

```txt
Task: <one-line action>
Context: <source document/canvas + only the state needed for the action>
Constraints: <must/avoid requirements, max two lines>
Output: <artifact, code change, review, or short answer target>
```

## Selection Rule

When a task creates a durable artifact, select the artifact document itself using its artifact path as `documentId`. Treat `task-result:*` messages and three-line status updates as wrappers: useful for the feed, but not the default canvas view.
