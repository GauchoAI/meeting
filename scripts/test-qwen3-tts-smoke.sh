#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${QWEN3_TTS_URL:-http://127.0.0.1:8794/synthesize}"
OUT_DIR="${QWEN3_TTS_SMOKE_DIR:-"$ROOT/.meeting/tmp/qwen3-tts-smoke"}"

mkdir -p "$OUT_DIR"

curl -fsS "$URL" \
  -H 'Content-Type: application/json' \
  -d '{"language":"english","text":"Codex is ready. I can summarize the meeting and raise my hand when I have a useful suggestion."}' \
  -o "$OUT_DIR/qwen3-server-english.wav"

curl -fsS "$URL" \
  -H 'Content-Type: application/json' \
  -d '{"language":"spanish","text":"Codex está listo. Puedo resumir la reunión y levantar la mano cuando tenga una sugerencia útil."}' \
  -o "$OUT_DIR/qwen3-server-spanish.wav"

curl -fsS "$URL" \
  -H 'Content-Type: application/json' \
  -d '{"language":"russian","text":"Codex готов. Я могу кратко записывать встречу и поднять руку, когда есть полезное предложение."}' \
  -o "$OUT_DIR/qwen3-server-russian.wav"

printf '%s\n' "$OUT_DIR/qwen3-server-english.wav"
printf '%s\n' "$OUT_DIR/qwen3-server-spanish.wav"
printf '%s\n' "$OUT_DIR/qwen3-server-russian.wav"
