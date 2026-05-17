# Running The Program

This is the full local live Meeting stack: browser UI, API, Pi/Codex agent worker, local STT, and local TTS.

## One-command local live run

From the repo root:

```bash
pnpm install
cp .env.example .env
pnpm dev:local-live
```

Then open:

```text
http://localhost:5175/stable.html
```

Click `Join meeting`, then choose a capture mode:

- `Hold Space`: press and hold Space while speaking, then release to send the turn.
- `Hands-free`: the stable shell uses local VAD to detect speech turns automatically.

The stable shell owns microphone capture and speech playback; the React app inside the iframe can hot reload without dropping the voice session.

Use `5175` for source development. If you see an older app on `5173`, that is the copied runtime/daemon surface and may not have the current speech routes.

## What the command starts

`pnpm dev:local-live` runs `scripts/start-local-live.sh`. It starts or reuses these services:

| Service | Command | Port |
| --- | --- | --- |
| Web, API, and agent worker | `pnpm dev` | web `5175`, API `4317` |
| Local TTS | `scripts/start-voxtral-mlx-tts.sh` | `8792` |
| Local STT | `scripts/start-parakeet-stt-server.sh` | `8793` |

The launcher uses detached `screen` sessions named `meeting-dev`, `meeting-voxtral-tts`, and `meeting-parakeet-stt`.

## Restart and stop

Restart the whole local live stack:

```bash
pnpm dev:local-live -- --restart
```

Stop it:

```bash
pnpm dev:local-live:stop
```

See the detached sessions:

```bash
screen -ls
```

## Logs

```text
/tmp/meeting-source-dev.log
.meeting/voxtral-mlx-tts.log
.meeting/parakeet-stt.log
```

Useful tails:

```bash
tail -f /tmp/meeting-source-dev.log
tail -f .meeting/voxtral-mlx-tts.log
tail -f .meeting/parakeet-stt.log
```

## Smoke checks

Check the Meeting API and selected speech providers:

```bash
curl http://127.0.0.1:4317/health
curl http://127.0.0.1:8793/health
```

Check that Meeting can synthesize a real WAV through local TTS:

```bash
curl -D - \
  -o /tmp/meeting-tts-smoke.wav \
  -X POST http://127.0.0.1:4317/tts/synthesize \
  -H 'content-type: application/json' \
  --data '{"text":"Meeting speech smoke test."}'

file /tmp/meeting-tts-smoke.wav
```

A healthy TTS smoke test returns `HTTP/1.1 200 OK`, `X-TTS-Provider: mlx-voxtral`, and a `RIFF ... WAVE audio` file.

## Manual foreground run

Use this when you want each process visible in its own terminal:

```bash
pnpm dev
```

```bash
scripts/start-voxtral-mlx-tts.sh
```

```bash
scripts/start-parakeet-stt-server.sh
```

Open:

```text
http://localhost:5175/stable.html
```

## First-run notes

- `pnpm install` is required before the app can run.
- `scripts/start-voxtral-mlx-tts.sh` creates `.venv-voxtral-tts` if needed and may download/load the MLX Voxtral model on first use.
- `scripts/start-parakeet-stt-server.sh` expects Handy's Parakeet model at `~/Library/Application Support/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8`, unless `PARAKEET_STT_MODEL_PATH` points elsewhere.
- Pi image generation is enabled project-locally through `pi-codex-image-gen`, which registers `codex_generate_image` and saves generated images under `.pi/generated-images/`. If a fresh checkout does not list it, run `PI_TELEMETRY=0 pi install npm:pi-codex-image-gen --local`.
- The browser may ask for microphone permission the first time you click `Join meeting`.
- `Hold Space` is still the safest capture mode for debugging. `Hands-free` is available for natural conversation; it waits 1600 ms of silence before sending a turn, prepares local TTS while listening, defers playback briefly on raw mic activity, and cancels pending speech only when a confirmed host transcript arrives.

## Troubleshooting

- `/tts/synthesize` returns `404`: you are probably on the stale copied runtime or old API. Use `http://localhost:5175/stable.html` and run `pnpm dev:local-live -- --restart`.
- `/tts/synthesize` returns `503 fetch failed`: the selected TTS endpoint is down. Check port `8792` and `.meeting/voxtral-mlx-tts.log`.
- The app listens but does not transcribe: check port `8793`, `curl http://127.0.0.1:8793/health`, and `.meeting/parakeet-stt.log`.
- Backend smoke tests pass but you hear nothing: check the browser tab, audio output device, and that you clicked `Join meeting`.
- Hands-free sends accidental turns or cuts too eagerly: switch back to `Hold Space`, then tune `meeting.localSpeechSilenceMs` or the VAD threshold in `apps/web/public/stable.html`.
- Hands-free interrupts the local voice too often because of speaker echo: run `localStorage.setItem("meeting.localAcousticBargeIn", "false")` in the browser console and reload the stable shell.
- Hands-free starts speaking too soon after a pause: run `localStorage.setItem("meeting.localSpeechPlaybackQuietMs", "1000")` in the browser console and reload the stable shell.
- Hands-free waits too long because of non-speech noise: run `localStorage.setItem("meeting.localUnconfirmedMicDeferMs", "1000")` in the browser console and reload the stable shell.
