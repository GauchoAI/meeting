#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${WHISPER_MODEL_PATH:-models/ggml-small.bin}"
HOST="${WHISPER_SERVER_HOST:-127.0.0.1}"
PORT="${WHISPER_SERVER_PORT:-8790}"
THREADS="${WHISPER_THREADS:-8}"
TMP_DIR="${WHISPER_SERVER_TMP_DIR:-$ROOT/.meeting/tmp}"

if ! command -v whisper-server >/dev/null 2>&1; then
  echo "[meeting] whisper-server is missing. Run scripts/setup-whisper.cpp.sh first." >&2
  exit 1
fi

case "$MODEL" in
  /*) MODEL_PATH="$MODEL" ;;
  *) MODEL_PATH="$ROOT/$MODEL" ;;
esac

mkdir -p "$TMP_DIR"

echo "[meeting] starting whisper-server on http://$HOST:$PORT/inference"
echo "[meeting] model: $MODEL_PATH"
exec whisper-server \
  -m "$MODEL_PATH" \
  --host "$HOST" \
  --port "$PORT" \
  --convert \
  --tmp-dir "$TMP_DIR" \
  -t "$THREADS"
