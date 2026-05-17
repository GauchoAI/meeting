# Local STT Voice Path

The reliable voice architecture is: browser capture sends explicit speech turns, the selected local STT provider transcribes them, Pi/Codex owns reasoning and tools, and the stable shell speaks prepared replies through local TTS only.

## Runtime Shape

- The stable shell at `http://localhost:5175/stable.html` owns mic capture and speech output so the meeting UI can hot reload without dropping voice state.
- Local capture defaults to push-to-talk: hold Space while speaking, release Space to send one clip to Whisper.
- The API receives only stable-shell chunks with `client=stable-vad-v1`; legacy chunks are ignored for local providers unless `MEETING_ACCEPT_LEGACY_AUDIO_CHUNKS=true`.
- `STT_PROVIDER=parakeet-http` is the current committed local default. `local-whisper`, `voxtral-http`, and `moshi-http` are still available for explicit tests.
- Local STT providers keep OpenAI Realtime disabled by default. Set `MEETING_ALLOW_OPENAI_REALTIME=true` only for explicit paid realtime tests.
- `WHISPER_SERVER_URL=http://127.0.0.1:8790/inference` enables the preloaded `whisper-server` path. Without it, the API falls back to spawning `whisper-cli` per chunk.

## Low-Latency Mode

The current live default is Parakeet:

```env
MEETING_SPEECH_MODE=live
STT_PROVIDER=parakeet-http
PARAKEET_STT_URL=http://127.0.0.1:8793/transcribe
```

Run Whisper as a persistent server before starting or restarting the API when comparing against the old Whisper path:

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

To try Handy's downloaded Parakeet V3 model instead of Whisper:

```bash
scripts/start-parakeet-stt-server.sh
```

Then configure:

```env
STT_PROVIDER=parakeet-http
PARAKEET_STT_URL=http://127.0.0.1:8793/transcribe
```

## Capture Mode

The default local capture mode is explicit push-to-talk. This is more reliable than acoustic VAD while tuning because it avoids sending tiny or badly cut chunks to the selected local STT provider.

The stable shell also exposes `Hands-free`, which enables automatic VAD capture so the host can speak without holding Space. This is the natural conversation mode, but it is more sensitive to room noise, laptop speaker echo, and silence-threshold tuning.

Use the capture selector in the stable-shell toolbar:

- `Hold Space`: press and hold Space while speaking, then release to send one clip.
- `Hands-free`: local VAD starts recording when the mic level crosses the speech threshold and sends the clip after sustained silence. The default silence window is 1600 ms so short thinking pauses are less likely to make the agent answer over the host.

The selector persists in local storage. The equivalent console command is:

```js
localStorage.setItem("meeting.localCaptureMode", "auto-vad")
```

To return to push-to-talk from the console:

```js
localStorage.removeItem("meeting.localCaptureMode")
```

## Interruption

When Codex is speaking, the stable shell keeps VAD alive but suppresses audio uploads so the agent voice is not fed back into Whisper. In `Hands-free` mode, acoustic barge-in is enabled by default: sustained mic activity after a short grace period interrupts local TTS and returns the shell to listening.

Local TTS preparation is not the same as playback. The shell can prepare a response while it is still listening, but before playing audio it checks the mic again. Raw VAD activity only defers playback for a bounded window, because room noise and speaker echo can cross the mic threshold. If that mic activity does not become a confirmed `utterance.final` from the host, local TTS continues. The pending local voice is cancelled only when a confirmed host transcript arrives, so a real newer host turn wins without losing audio to empty STT chunks.

To force barge-in on from the browser console:

```js
localStorage.setItem("meeting.localAcousticBargeIn", "true")
```

To force it off:

```js
localStorage.setItem("meeting.localAcousticBargeIn", "false")
```

To return to the mode-dependent default:

```js
localStorage.removeItem("meeting.localAcousticBargeIn")
```

## Remaining V2 Work

- Add partial transcript events from a true streaming Whisper worker or `whisper-stream`.
- Make the local Chatterbox TTS worker stream chunks instead of waiting for a full WAV before playback.
- Add an explicit "Codex was interrupted" event so Pi can stop long replies or summarize where it left off.
