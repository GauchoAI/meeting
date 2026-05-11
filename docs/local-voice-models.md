# Local voice model experiments

The stable Meeting pipeline should keep Pi/Codex as the tool-using brain. Local voice models should feed streams into that brain rather than own durable artifact or code responsibilities.

## Recommendation

1. Use Parakeet V3 as the multilingual local drop-in STT experiment when Handy has already downloaded the ONNX model.
2. Use Moshi MLX as a sidecar full-duplex voice lab.
3. Keep `message_pi_agent`, `run_codex_task`, artifacts, and task lifecycle in Pi/Codex.

## Voxtral Realtime STT

Model: `mistralai/Voxtral-Mini-4B-Realtime-2602`

Purpose: replace local Whisper on the existing `/audio/chunk` path while preserving the same transcript JSONL and Pi/Codex downstream behavior.

Start the experimental Transformers bridge:

```bash
cd /Users/miguel_lemos/Desktop/mamba3/meeting
python3 -m venv .venv-voxtral
source .venv-voxtral/bin/activate
python -m pip install -U pip
python -m pip install -U "transformers>=5.2.0" "mistral-common[audio]" accelerate torch soundfile soxr librosa
python scripts/voxtral-transformers-server.py
```

Then point the Meeting API at it:

```bash
STT_PROVIDER=voxtral-http \
VOXTRAL_STT_URL=http://localhost:8787/transcribe \
pnpm dev:api
```

The bridge is intentionally simple: it receives each browser audio chunk, transcribes it, and returns JSON. This tests local quality and integration before investing in a true streaming vLLM deployment.

## Parakeet V3 STT

Model: `parakeet-tdt-0.6b-v3-int8`

Purpose: replace local Whisper on the existing `/audio/chunk` path with Handy's fast ONNX Parakeet V3 model while preserving the same transcript JSONL and Pi/Codex downstream behavior.

Start the local bridge:

```bash
cd /Users/miguel_lemos/Desktop/mamba3/meeting
scripts/start-parakeet-stt-server.sh
```

Then point the Meeting API at it:

```bash
STT_PROVIDER=parakeet-http \
PARAKEET_STT_URL=http://localhost:8793/transcribe \
pnpm dev:api
```

By default the bridge reuses Handy's downloaded model at:

```txt
~/Library/Application Support/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8
```

Override it with `PARAKEET_STT_MODEL_PATH` if the model lives elsewhere. The bridge keeps the model loaded and accepts raw browser audio chunks, converts them to 16 kHz mono WAV through `ffmpeg`, and returns `{ text, model, elapsedMs }` like the existing Voxtral/Moshi bridges.

Run the local multilingual smoke test after starting the bridge:

```bash
scripts/test-parakeet-stt-smoke.sh
```

This generates short macOS `say` samples for Russian and Spanish, posts them to the Parakeet bridge, and prints the returned transcript. It is a controlled sanity check, not a replacement for human-speaker acceptance testing.

The stable shell exposes these voice modes:

- `OpenAI voice`: the previous OpenAI Realtime listen/speak path.
- `Local Parakeet`: microphone chunks go to `/audio/chunk`, which uses Parakeet through `STT_PROVIDER=parakeet-http`; Pi/Codex remains the tool-using brain; explicit Pi voice messages must use the local TTS path, not browser speech synthesis.
- `Local Voxtral`: microphone chunks go to `/audio/chunk`, which uses Voxtral through `STT_PROVIDER=voxtral-http`; Pi/Codex remains the tool-using brain; explicit Pi voice messages must use the local TTS path, not browser speech synthesis.
- `Hybrid`: OpenAI Realtime remains the conversational voice while the selected local STT provider also writes transcript events into the Meeting/Pi pipeline.

When `.env` sets a local provider such as `STT_PROVIDER=parakeet-http`, the stable shell defaults to local voice unless `localStorage.meeting.voiceMode` already has a saved preference.

## Moshi MLX Lab

Model: `kyutai/moshika-mlx-bf16`

Purpose: test full-duplex speech behavior on Apple Silicon. Moshi is interesting because it can listen and speak in a more natural loop, but it should not own tools or artifacts.

Start the lab:

```bash
cd /Users/miguel_lemos/Desktop/mamba3/meeting
scripts/run-moshi-mlx-lab.sh
```

For Meeting integration, use Moshi only as a voice sidecar until it exposes a reliable transcript/event stream. If a local bridge exposes `POST /transcribe`, the API already accepts:

```bash
STT_PROVIDER=moshi-http \
MOSHI_STT_URL=http://localhost:8788/transcribe \
pnpm dev:api
```

## Why this shape

- Whisper and Voxtral are transcript providers.
- Moshi is a voice experience provider.
- Pi/Codex is the reasoning, tool-use, artifact, and self-improvement provider.
- The durable interface remains files and JSONL, so each piece can be swapped independently.

## Text-to-speech providers

The browser shell never uses `speechSynthesis`. All speech output goes through the Meeting API:

```bash
POST http://localhost:4317/tts/synthesize
POST http://localhost:4317/tts/stream
```

By default this proxies to the local Chatterbox Turbo worker:

```bash
MEETING_TTS_PROVIDER=chatterbox-turbo
CHATTERBOX_TTS_URL=http://127.0.0.1:8791/synthesize
```

Mistral-hosted Voxtral TTS is available as an explicit provider when a Mistral API key is present:

```bash
MEETING_TTS_PROVIDER=mistral-voxtral
MISTRAL_API_KEY=...
MISTRAL_TTS_MODEL=voxtral-mini-tts-2603
MISTRAL_TTS_RESPONSE_FORMAT=wav
MISTRAL_TTS_PCM_SAMPLE_RATE=24000
```

Optional voice controls:

```bash
MISTRAL_TTS_VOICE_ID=...
MISTRAL_TTS_REF_AUDIO_PATH=voice-reference.wav
MISTRAL_TTS_BASE_URL=https://api.mistral.ai/v1
```

Use `wav` for `/tts/synthesize` because it returns browser-playable audio with no client-side decoding work. Use `/tts/stream` for the Voxtral low-latency path: the API requests `stream=true` and `response_format=pcm`, relays Mistral `speech.audio.delta` events, and the stable shell schedules PCM float32 chunks through WebAudio as they arrive. If streaming fails, the shell falls back to `/tts/synthesize`; it still never falls back to browser `speechSynthesis`.

Local Voxtral TTS on Apple Silicon uses MLX Audio:

```bash
scripts/start-voxtral-mlx-tts.sh
```

Then configure the Meeting API:

```bash
MEETING_TTS_PROVIDER=mlx-voxtral
VOXTRAL_MLX_TTS_URL=http://127.0.0.1:8792/v1/audio/speech
VOXTRAL_MLX_TTS_MODEL=mlx-community/Voxtral-4B-TTS-2603-mlx-4bit
VOXTRAL_MLX_TTS_VOICE=casual_male
VOXTRAL_MLX_TTS_AUTO_VOICE=true
VOXTRAL_MLX_TTS_SPANISH_VOICE=es_male
VOXTRAL_MLX_TTS_RESPONSE_FORMAT=wav
VOXTRAL_MLX_TTS_STREAMING_INTERVAL=0.32
```

The first request downloads and loads the MLX model, so it can take a while. After warmup, `/tts/stream` posts `stream=true` and `response_format=pcm` to MLX Audio, converts raw PCM int16 chunks to the browser player's float32 SSE format, and starts playback before the full sentence is complete.

For this Voxtral model, each independently synthesized chunk can carry a slightly different room/noise profile. The stable shell therefore asks Codex/Pi for a short first spoken sentence, then batches later speech into longer chunks to reduce audible volume/background shifts. The shell also strips file paths, file names, environment variables, raw JSON, and markdown syntax from spoken text; those details stay visible in the UI instead of being read aloud.

Spanish with the English `casual_male` voice can degrade badly. The API auto-selects `VOXTRAL_MLX_TTS_SPANISH_VOICE` for likely Spanish text unless `VOXTRAL_MLX_TTS_AUTO_VOICE=false`.

## Voxtral TTS notes from `voxtral-demo.txt`

The pasted talk transcript describes the current Voxtral TTS shape:

- The model receives a complete text segment and then generates audio.
- Early audio packets can arrive before the full audio is complete, lowering perceived latency.
- True streaming text input, where the TTS model speaks while the LLM is still generating text tokens, is described as future/uncertain architecture work.
- Open weights are available, but the voice-cloning encoder is not fully open in the talk; hosted voice/reference-audio paths remain provider-specific.

For this project that means the practical v1 path is sentence/utterance chunking: Pi/Codex produces concise text, `/tts/synthesize` can speak that text as a completed audio response, and `/tts/stream` can lower perceived latency without giving the voice model artifact/tool responsibility.

That streaming route now exists as `/tts/stream`. It still operates on complete utterance text, which matches the transcript: Voxtral emits early audio packets for a supplied text segment, but Pi/Codex remains responsible for deciding what text should be spoken.

The stable shell also watches Pi/Codex `agent.message` draft updates. For status-surface drafts, it extracts complete speech-sized sentences and queues them immediately, so local voice can begin speaking while Codex is still writing the rest of the answer. Canvas/artifact markdown is not read aloud as a stream; final canvas updates remain summarized instead of narrating raw diagrams or code blocks.

The speech queue prefetches one upcoming TTS job while the current sentence is playing. A larger worker pool overloaded local Chatterbox on Apple Silicon and increased tail latency, so the stable default is ordered playback with one lookahead. Draft speech also uses earlier soft clause boundaries so the first spoken chunk can start before a long first sentence is complete.

## Sources

- Voxtral Realtime model card: https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602
- Mistral Voxtral TTS model card: https://huggingface.co/mistralai/Voxtral-4B-TTS-2603
- Mistral text-to-speech API: https://docs.mistral.ai/capabilities/audio/text_to_speech/
- Moshi MLX model card: https://huggingface.co/kyutai/moshika-mlx-bf16
