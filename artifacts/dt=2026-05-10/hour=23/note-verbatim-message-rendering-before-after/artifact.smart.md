# Verbatim Message Rendering: Current vs Preferred

## Example 1 — current handoff rendering

```txt
Realtime agent handoff to pi-agent. Treat the JSONL below as the task handoff, not as a raw transcript dump.
Use the Meeting artifact tools to answer in the Meeting UI. If a durable artifact is requested, create/update it and show it.

{"ts":"2026-05-10T02:03:22.969Z","role":"realtime-agent","kind":"handoff_summary","taskKey":"show-verbatim-current-vs-preferred-message-rendering","taskClass":"artifact.render","title":"Show verbatim current vs preferred message rendering","text":"Create a durable artifact that shows verbatim examples of how voice agent messages are currently rendered versus how they should be rendered to preserve the same actionable tasks. Include side-by-side or clearly separated before/after verbatim blocks and a minimal reusable template. Keep it concise and terminal-friendly. Ensure the artifact remains selected and visible without wrapper/status messages overriding the canvas.","cwd":"/Users/miguel_lemos/Desktop/mamba3/meeting","sourceDocumentId":"realtime-live-canvas"}
```

## Example 1 — preferred rendering

```txt
Task: Create a durable artifact showing current vs preferred voice-agent message rendering.
Context: Source document is realtime-live-canvas; task class is artifact.render.
Constraints: Use verbatim before/after blocks; preserve actionable content; keep concise; open the artifact; avoid wrapper/status focus steal.
Output: Selectable Meeting artifact.
```

## Example 2 — current troubleshooting fragments

```txt
Can you take a look? May be there is a bug.
Two times I have experienced since then.
an output. My voice asin gets this call
```

## Example 2 — preferred rendering

```txt
Task: Investigate possible repeated UI/voice-agent delivery bug.
Context: After pi-agent output, the voice agent receives a notification and may post a competing status message.
Constraints: Check whether status-only messages are treated as primary outputs; prevent wrappers from stealing canvas focus.
Output: Brief diagnosis plus patch or next step.
```

## Minimal template

```txt
Task: <actionable request>
Context: <current canvas/artifact + relevant trigger>
Constraints: <must keep / must avoid>
Output: <answer, artifact, code patch, or status>
```

## Rule

Keep raw JSONL and routing metadata out of the human-facing prompt unless it changes the action. Preserve task, context, constraints, and output target.
