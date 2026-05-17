# Meeting latency measurement

This note documents the event-log based latency check used during the hands-free Meeting test. The primary user-facing question is perceived response latency: once the host stops speaking, how long until the local agent starts speaking?

## Script

Use:

```bash
./scripts/measure-meeting-latency.mjs --since 2026-05-17T02:30:00Z --limit 20
```

The script reads `.meeting/events.jsonl` by default and scans only the tail of the large JSONL file. It requires no npm dependencies.

Useful options:

```bash
./scripts/measure-meeting-latency.mjs \
  --file .meeting/events.jsonl \
  --tail-mb 80 \
  --since 2026-05-17T02:30:00Z \
  --speaker Host \
  --window-s 60 \
  --limit 25
```

JSON output:

```bash
./scripts/measure-meeting-latency.mjs --since 2026-05-17T02:30:00Z --json
```

## Event sequence measured

For each `utterance.final` from `speakerLabel: "Host"`, the script looks backward for STT/audio events and forward for agent/TTS events.

New stable-shell events include `clientStoppedAt`, the browser timestamp captured when the recorder stops. That enables `speechEndTo*` metrics. Older logs do not contain this timestamp, so those fields appear as `—`.

Backward-looking STT/audio events:

- `audio.upload.received`
- `clientStoppedAt` inside the `audio.upload.received` details
- `stt.start`
- `stt.end`
- `utterance.final`

Forward-looking agent/TTS events:

- `pi.extension.received_utterance`
- `agent_start`
- final `agent.message`
- `tts.stream.start`
- `local.tts.playback.start`
- `tts.stream.end`

## Metrics

The report includes:

- `audioUploadToUtterance`: audio upload received → final transcript
- `speechEndToUtterance`: browser recorder stopped → final transcript
- `sttStartToUtterance`: STT start → final transcript
- `sttEndToUtterance`: STT end → final transcript
- `utteranceToAgentReceived`: final transcript → Pi extension received utterance
- `utteranceToAgentStart`: final transcript → Pi agent start
- `utteranceToFinalMessage`: final transcript → final Pi agent message
- `utteranceToTtsStart`: final transcript → local TTS stream start
- `utteranceToTtsEnd`: final transcript → local TTS stream end
- `speechEndToTtsStart`: browser recorder stopped → local TTS request
- `speechEndToPlaybackStart`: browser recorder stopped → first local TTS playback trace

Important caveat: `audioUploadToUtterance` starts when the uploaded audio chunk is received, not when the user first begins speaking. For current logs, `speechEndToPlaybackStart` is the closest human-perceived latency metric.

Long host turns can still feel fast even when a later paragraph is still being processed. The desired behavior is pipelined: the agent may start answering earlier finalized paragraphs while later host paragraphs continue arriving. For this reason, interpret `speechEndToPlaybackStart` per finalized utterance, not as a single whole-monologue score.

## Latest run

Command run:

```bash
./scripts/measure-meeting-latency.mjs --since 2026-05-17T02:30:00Z --limit 20
```

Result summary from 25 Host utterances:

| Metric | n | Median | Mean | p90 | Min | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `audioUploadToUtterance` | 25 | 0.202s | 0.280s | 0.561s | 0.099s | 0.610s |
| `sttStartToUtterance` | 25 | 0.201s | 0.278s | 0.560s | 0.098s | 0.608s |
| `sttEndToUtterance` | 25 | 0.000s | 0.000s | 0.001s | 0.000s | 0.001s |
| `utteranceToAgentReceived` | 25 | 0.002s | 0.114s | 0.003s | 0.001s | 1.042s |
| `utteranceToAgentStart` | 20 | 0.005s | 0.053s | 0.010s | 0.003s | 0.961s |
| `utteranceToFinalMessage` | 23 | 10.414s | 9.310s | 13.568s | 0.134s | 22.208s |
| `utteranceToTtsStart` | 21 | 10.172s | 8.895s | 13.621s | 0.140s | 22.216s |
| `utteranceToTtsEnd` | 21 | 12.572s | 11.510s | 17.786s | 1.485s | 24.875s |

Interpretation:

- STT and event handoff are fast: roughly 0.3 seconds from audio upload to final transcript.
- Pi handoff is effectively immediate: about 0.002 seconds median to received event and 0.005 seconds median to `agent_start` when a fresh start appears.
- Most latency is agent-side reasoning, tool use, and response generation: roughly 11 seconds median to final message in this run.
- Some turns have no fresh `agent_start` because the agent was already busy and the utterance was queued or overlapped with an existing response.
- This run predates `clientStoppedAt` and `local.tts.playback.start`, so the new perceived-latency columns report `n=0` until the stable shell is reloaded and new turns are recorded.
