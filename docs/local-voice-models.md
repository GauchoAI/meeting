# Local voice model experiments

The stable Meeting pipeline should keep Pi/Codex as the tool-using brain. Local voice models should feed streams into that brain rather than own durable artifact or code responsibilities.

## Recommendation

1. Use Voxtral as the first local drop-in STT experiment.
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

The stable shell exposes three voice modes:

- `OpenAI voice`: the previous OpenAI Realtime listen/speak path.
- `Local Voxtral`: microphone chunks go to `/audio/chunk`, which uses Voxtral through `STT_PROVIDER=voxtral-http`; Pi/Codex remains the tool-using brain; explicit Pi voice messages must use the local TTS path, not browser speech synthesis.
- `Hybrid`: OpenAI Realtime remains the conversational voice while local Voxtral also writes transcript events into the Meeting/Pi pipeline.

When `.env` sets `STT_PROVIDER=voxtral-http`, the stable shell defaults to `Local Voxtral` unless `localStorage.meeting.voiceMode` already has a saved preference.

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
```

By default this proxies to the local Chatterbox Turbo worker:

```bash
MEETING_TTS_PROVIDER=chatterbox-turbo
CHATTERBOX_TTS_URL=http://127.0.0.1:8791/synthesize
```

Mistral Voxtral TTS is available as an explicit provider:

```bash
MEETING_TTS_PROVIDER=mistral-voxtral
MISTRAL_API_KEY=...
MISTRAL_TTS_MODEL=voxtral-mini-tts-2603
MISTRAL_TTS_RESPONSE_FORMAT=wav
```

Optional voice controls:

```bash
MISTRAL_TTS_VOICE_ID=...
MISTRAL_TTS_REF_AUDIO_PATH=voice-reference.wav
MISTRAL_TTS_BASE_URL=https://api.mistral.ai/v1
```

Use `wav` for the current stable UI because it returns browser-playable audio with no client-side decoding work. Voxtral also exposes `pcm`, but the current shell waits for the complete `/tts/synthesize` response before playback, so `pcm` does not yet deliver the low-latency first-audio behavior by itself. To exploit Voxtral's lowest-latency path, add a separate streaming TTS route that forwards `text/event-stream` audio deltas and plays them incrementally in the stable shell.

## Voxtral TTS notes from `voxtral-demo.txt`

The pasted talk transcript describes the current Voxtral TTS shape:

- The model receives a complete text segment and then generates audio.
- Early audio packets can arrive before the full audio is complete, lowering perceived latency.
- True streaming text input, where the TTS model speaks while the LLM is still generating text tokens, is described as future/uncertain architecture work.
- Open weights are available, but the voice-cloning encoder is not fully open in the talk; hosted voice/reference-audio paths remain provider-specific.

For this project that means the practical v1 path is sentence/utterance chunking: Pi/Codex produces concise text, `/tts/synthesize` speaks that text, and a later streaming route can lower latency without giving the voice model artifact/tool responsibility.

## Sources

- Voxtral Realtime model card: https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602
- Mistral Voxtral TTS model card: https://huggingface.co/mistralai/Voxtral-4B-TTS-2603
- Mistral text-to-speech API: https://docs.mistral.ai/capabilities/audio/text_to_speech/
- Moshi MLX model card: https://huggingface.co/kyutai/moshika-mlx-bf16
