# Scripts

Scripts are grouped by how they are used. Prefer the root `package.json` commands for everyday development and use these scripts for local services, setup, and focused checks.

## Development And Runtime

| Script | Purpose |
| --- | --- |
| `start-local-live.sh` | Starts the full source app plus local Parakeet STT and MLX Voxtral TTS stack. |
| `stop-local-live.sh` | Stops the local-live screen sessions and ports. |
| `dev-source.sh` | Shell helper for local development environment variables. |
| `meeting-daemon.sh` | Runs the local Meeting daemon process. |
| `advertise-meeting.mjs` | Publishes/heartbeats a host meeting into the Firebase-backed GitHub Pages lobby. |
| `meeting-mcp-stdio.sh` | Starts the MCP server over stdio. |
| `sync-runtime.sh` | Syncs runtime assets while preserving the stable shell contract. |
| `watch-runtime-sync.sh` | Watches and syncs runtime files during local development. |

## Installers

| Script | Purpose |
| --- | --- |
| `install-daemon.sh` | Installs the local Meeting daemon. |
| `install-dev-daemon.sh` | Installs the development daemon variant. |
| `install-mcp-clients.sh` | Configures local Codex and Claude Code MCP clients. |
| `setup-whisper.cpp.sh` | Installs or prepares the local Whisper fallback path. |

## Speech Services

| Script | Purpose |
| --- | --- |
| `start-parakeet-stt-server.sh` | Starts the local Parakeet HTTP STT bridge. |
| `start-whisper-server.sh` | Starts the whisper.cpp server fallback. |
| `start-voxtral-mlx-tts.sh` | Starts local MLX Voxtral TTS. |
| `start-qwen3-tts.sh` | Starts Qwen3 TTS for narration/offline audio. |
| `start-chatterbox-tts.sh` | Starts the legacy Chatterbox local TTS provider. |
| `run-moshi-mlx-lab.sh` | Starts the Moshi full-duplex experiment. |
| `voxtral-transformers-server.py` | Experimental Voxtral STT bridge. |
| `qwen3-tts-server.py` | Qwen3 HTTP TTS worker. |
| `chatterbox-tts-server.py` | Chatterbox HTTP TTS worker. |

## Benchmarks And Checks

| Script | Purpose |
| --- | --- |
| `benchmark-speech-providers.mjs` | Unified local speech provider benchmark; exposed as `pnpm benchmark:speech`. |
| `measure-meeting-latency.mjs` | Measures Meeting voice/STT/agent/TTS latency from `.meeting/events.jsonl`; see `docs/meeting-latency-measurement.md`. |
| `test-parakeet-stt-smoke.sh` | Parakeet STT smoke test with generated local audio. |
| `test-qwen3-tts-smoke.sh` | Qwen3 TTS smoke test for English, Spanish, and Russian. |
| `check-assistant-delivery.mjs` | Guardrail checks for assistant output delivery. |
| `test-realtime-sleep.mjs` | Realtime sleep mode tests. |

## Artifact And UI Utilities

| Script | Purpose |
| --- | --- |
| `browser-screenshot.mjs` | Captures browser screenshots for visual inspection. |
| `visual-artifact-inspect.mjs` | Inspects generated visual artifacts. |
| `promote-diagram-image.mjs` | Promotes rendered diagram images into artifacts. |
| `export-meeting-session.mjs` | Exports the current meeting session. |
| `smart-artifact.mjs` | Creates or updates smart artifact metadata. |
