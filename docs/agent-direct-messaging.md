# Agent direct messaging and low-noise handoffs

## Default pi-agent handoff

Human-facing pi-agent handoffs should default to the compact shape:

```txt
Task: <actionable request>
Context: <current artifact/canvas + relevant trigger>
Constraints: <must keep / must avoid>
Output: <answer, artifact, code patch, or status>
```

Full routing metadata, JSONL, artifact indexes, and tool inventories should remain available internally for debugging or ambiguous artifact resolution, but should not be shown by default.

## Voice agent → pi-agent

Use the Realtime tool `message_pi_agent` for lightweight coordination that should not create a task, durable artifact, or canvas update.

Example:

```json
{
  "intent": "question",
  "message": "Can you confirm whether the current canvas should remain selected?",
  "taskKey": "optional-related-task"
}
```

The message is appended to `.meeting/pipeline/implementation/inbox/pi-direct-messages.jsonl` and logged by the pi-agent worker.

## Pi-agent → voice agent

Use `meeting_message_voice_agent` instead of `meeting_post_markdown` when the goal is to ask the voice agent to raise its hand or speak a short summary. This emits a status-surface coordination message with a `voice-message:*` document id so the voice agent can observe it, but it does not update the canvas.

Example:

```txt
Intent: raise-hand
Message: Pi-agent recommends trying the low-noise handoff experiment.
When: After the current artifact remains selected.
```

## Guardrails

- Do not use status wrappers as canvas content.
- Do not include raw routing records unless they change the action.
- Keep direct messages short and explicit.
- Canvas artifacts remain the source of truth for durable content.
