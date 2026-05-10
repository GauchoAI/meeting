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

Use the Realtime tool `message_pi_agent` for lightweight coordination that should not create a durable artifact or canvas update. It may create a lightweight conversation task so the exchange has lifecycle visibility.

Example:

```json
{
  "intent": "question",
  "message": "Can you confirm whether the current canvas should remain selected?",
  "taskKey": "optional-related-task"
}
```

The message is appended to `.meeting/pipeline/implementation/inbox/pi-direct-messages.jsonl`, logged by the pi-agent worker with a distinct tag such as `[pi-agent:direct:inform]`, mirrored concisely to the same implementation handoff/terminal stream used by `run_codex_task` as a short voice-agent request, marked processed in `.meeting/pipeline/implementation/inbox/pi-direct-messages.seen.jsonl`, and queued as a lightweight `conversation` implementation task so it is injected into pi-agent/Codex just like `run_codex_task`.

The Pi extension must pass these direct coordination utterances through without adding the generic Meeting prompt wrapper or artifact index context. See `docs/pi-meeting-prompt-wrapping.md`.

Direct voice-agent requests should tell Pi to reply with `meeting_message_voice_agent`. That keeps the back-and-forth in the voice-agent channel instead of pushing a canvas/status update that the Realtime agent may ignore.

For autonomous back-and-forth, each side should send one concise turn at a time. Pi should use `intent=question` or `intent=speak` only when it expects another voice-agent turn; otherwise it should use `intent=inform`. The Realtime side should answer a `voice-message:*` event by calling `message_pi_agent` at most once, or by returning `NO_ACTION` when the exchange is complete.

The direct channel also writes a compact shared memory log at `.meeting/pipeline/implementation/inbox/agent-dialogue.jsonl`. It records both directions:

```jsonl
{"direction":"realtime_to_pi","role":"realtime-agent","intent":"request","text":"3"}
{"direction":"pi_to_realtime","role":"pi-agent","intent":"inform","text":"4"}
```

The Realtime client injects the recent tail of this JSONL into every `voice-message:*` turn. This is intentional: the audio model should not be trusted to reconstruct a multi-turn agent-to-agent protocol from session memory alone.

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
- If the Realtime model emits plain internal text for a direct Pi/Codex turn instead of calling `message_pi_agent`, the stable shell relays that text to Pi and suppresses the local status bubble.
- Canvas artifacts remain the source of truth for durable content.
- `run_codex_task` and `message_pi_agent` must enqueue implementation tasks by themselves; `create_meeting_task` is useful for visibility but is not required for delivery.
- Code-change handoffs should return status plus a hand raise without replacing the current canvas; artifact render/edit tasks may publish canvas content.
- Implementation tasks should be terminal-visible with `[pi-agent:implementation:<status>]` tags; direct coordination should use `[pi-agent:direct:<intent>]` tags.
