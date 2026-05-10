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

## Sources

- Voxtral Realtime model card: https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602
- Moshi MLX model card: https://huggingface.co/kyutai/moshika-mlx-bf16
