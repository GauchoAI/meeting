# Local Whisper Voice Path

The reliable voice architecture is: browser VAD captures turns, local Whisper transcribes them, Pi/Codex owns reasoning and tools, and the stable shell speaks Codex replies through local/browser TTS.

## Runtime Shape

- The stable shell at `http://localhost:5175/stable.html` owns mic capture and speech output so the meeting UI can hot reload without dropping voice state.
- The API receives only stable VAD chunks with `client=stable-vad-v1`; legacy chunks are ignored for local providers unless `MEETING_ACCEPT_LEGACY_AUDIO_CHUNKS=true`.
- `STT_PROVIDER=local-whisper` keeps OpenAI Realtime disabled by default. Set `MEETING_ALLOW_OPENAI_REALTIME=true` only for explicit paid realtime tests.
- `WHISPER_SERVER_URL=http://127.0.0.1:8790/inference` enables the preloaded `whisper-server` path. Without it, the API falls back to spawning `whisper-cli` per chunk.

## Low-Latency Mode

Run Whisper as a persistent server before starting or restarting the API:

```bash
bash scripts/start-whisper-server.sh
```

Then keep this in `.env`:

```env
STT_PROVIDER=local-whisper
WHISPER_SERVER_URL=http://127.0.0.1:8790/inference
WHISPER_MODEL_PATH=models/ggml-small.bin
```

The server path avoids reloading the 465 MB `ggml-small.bin` model for every spoken turn. That is the biggest latency win available without returning to paid realtime models.

## Interruption

When Codex is speaking, the stable shell keeps VAD alive but suppresses audio uploads so the agent voice is not fed back into Whisper. Automatic acoustic barge-in is disabled by default because laptop speakers can trigger false interruptions.

For tuning only, enable it from the browser console:

```js
localStorage.setItem("meeting.localAcousticBargeIn", "true")
```

Disable it again with:

```js
localStorage.removeItem("meeting.localAcousticBargeIn")
```

## Remaining V2 Work

- Add partial transcript events from a true streaming Whisper worker or `whisper-stream`.
- Add a local streaming TTS worker if browser `speechSynthesis` is not good enough.
- Add an explicit "Codex was interrupted" event so Pi can stop long replies or summarize where it left off.
