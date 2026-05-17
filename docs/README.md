# Meeting Docs

This directory is the project knowledge base. Keep root-level `README.md` focused on quickstart and project shape; put longer architecture and operations notes here.

## Recommended Reading Order

1. `running-the-program.md` - commands to start, verify, restart, and stop the full local live stack.
2. `github-pages.md` - static Pages deployment and how to point it at a reachable Meeting API.
3. `multi-human-webrtc.md` - initial plan/scaffold for adding second-notebook human participants.
3. `reproducible-dev.md` - local development contract and stable runtime expectations.
4. `stable-shell.md` - why `stable.html` owns microphone and voice state.
4. `local-voice-models.md` - local STT/TTS provider setup and selector behavior.
5. `speech-provider-benchmarks.md` - measured local speech results and provider recommendations.
6. `assistant-output-delivery.md` - how assistant output reaches canvas/status surfaces.
7. `agent-direct-messaging.md` - low-noise handoffs between Realtime, Pi, and local workers.

## Operations

| Doc | Covers |
| --- | --- |
| `running-the-program.md` | Full local-live startup, stop, logs, smoke tests, and troubleshooting. |
| `github-pages.md` | GitHub Pages deployment and hosted/tunneled API configuration. |
| `reproducible-dev.md` | Source checkout workflow and validation expectations. |
| `multi-human-webrtc.md` | WebRTC/Firebase approach for multiple human participants and speaker attribution. |

## Architecture

| Doc | Covers |
| --- | --- |
| `artifacts.md` | Smart artifact layout and generated artifact metadata. |
| `rendering.md` | Markdown, diagram, and rendered artifact handling. |
| `stable-shell.md` | Long-lived browser shell and development constraints. |
| `wiki-engine.md` | Local wiki/artifact planning work. |
| `speech-video-market.md` | External speech/video provider market notes. |
| `multi-human-webrtc.md` | Browser peer audio architecture for real shared meetings. |

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
