# Pi Meeting Prompt Wrapping

## Root Cause

The Realtime API path can emit concise coordination text, but the project-local Pi extension is the final boundary before text enters the Pi terminal and model context.

The regression happened because `message_pi_agent` produced a concise message, then `.pi/extensions/meeting/index.ts` rebuilt it as a full Meeting prompt:

```txt
Meeting input from Realtime coordination:
taskClass: conversation
artifactIntent:
artifactIndex:
artifactTools:
message:
...
```

That made Pi appear to be rendering terminal messages incorrectly. The terminal was mostly showing the prompt it had actually received.

## Source Locations

- `apps/api/src/server.ts` builds concise Realtime-to-Pi events for `message_pi_agent` and `run_codex_task`.
- `.pi/extensions/meeting/index.ts` listens to Meeting utterances and calls `injectMeetingPrompt`.
- `.pi/extensions/meeting/index.ts` is where visible prompt decoration must be controlled.
- `apps/agent-worker/src/worker.ts` keeps deeper routing and artifact index metadata in diagnostic files. That metadata is allowed there.

## Fixed Behavior

- `realtime-direct-message` and `realtime-handoff` utterances pass through to Pi without the generic `Meeting input from ...` wrapper.
- `realtime-direct-message` prompts keep a small voice-agent envelope that asks Pi to reply via `meeting_message_voice_agent`.
- `conversation_only` turns do not include artifact intent, artifact index, or artifact tool inventory.
- Artifact-related turns include only minimal intent and instruction by default.
- Full artifact indexes are only injected into the Pi prompt when `MEETING_VERBOSE_ARTIFACT_CONTEXT=true`.

## V2 Rule

Do not put routing metadata into the visible/default Pi prompt unless it changes the action the model must take.

Default prompt surface:

```txt
[optional-intent] core message
```

Debug surface:

```txt
artifactIntent
artifactIndex
artifactTools
routing records
received input capture
```

For v2, keep these as separate channels: visible message, hidden routing context, and persisted debug trace.
