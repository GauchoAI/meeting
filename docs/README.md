# Meeting Docs

This directory is the project knowledge base. Keep root-level `README.md` focused on quickstart and project shape; put longer architecture and operations notes here.

## Recommended Reading Order

1. `reproducible-dev.md` - local development contract and stable runtime expectations.
2. `stable-shell.md` - why `stable.html` owns microphone and voice state.
3. `local-voice-models.md` - local STT/TTS provider setup and selector behavior.
4. `speech-provider-benchmarks.md` - measured local speech results and provider recommendations.
5. `assistant-output-delivery.md` - how assistant output reaches canvas/status surfaces.
6. `agent-direct-messaging.md` - low-noise handoffs between Realtime, Pi, and local workers.

## Architecture

| Doc | Covers |
| --- | --- |
| `artifacts.md` | Smart artifact layout and generated artifact metadata. |
| `rendering.md` | Markdown, diagram, and rendered artifact handling. |
| `stable-shell.md` | Long-lived browser shell and development constraints. |
| `wiki-engine.md` | Local wiki/artifact planning work. |
| `speech-video-market.md` | External speech/video provider market notes. |

## Speech And Realtime

| Doc | Covers |
| --- | --- |
| `local-whisper-voice.md` | Local STT path, including current Parakeet default and Whisper fallback. |
| `local-voice-models.md` | Parakeet, Voxtral, Moshi, Qwen3, and TTS provider setup. |
| `speech-provider-benchmarks.md` | Benchmark command, measured results, and recommendation matrix. |
| `realtime-sleep-mode.md` | Realtime agent sleep and wake behavior. |

## Agent Workflow

| Doc | Covers |
| --- | --- |
| `assistant-output-delivery.md` | Single-command canvas/status delivery workflow. |
| `agent-direct-messaging.md` | Direct messages and handoff queues. |
| `pi-meeting-prompt-wrapping.md` | Prompt wrapping for Pi meeting context. |

## Plans

Completed or historical plans live in `plans/` so they do not clutter the repo root.
