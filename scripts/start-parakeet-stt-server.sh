#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${PARAKEET_STT_HOST:-127.0.0.1}"
PORT="${PARAKEET_STT_PORT:-8793}"
MODEL_PATH="${PARAKEET_STT_MODEL_PATH:-"$HOME/Library/Application Support/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8"}"

if [[ ! -d "$MODEL_PATH" ]]; then
  echo "Parakeet model not found: $MODEL_PATH" >&2
  echo "Install it through Handy or set PARAKEET_STT_MODEL_PATH." >&2
  exit 1
fi

cd "$ROOT/tools/parakeet-stt-server"
export PARAKEET_STT_HOST="$HOST"
export PARAKEET_STT_PORT="$PORT"
export PARAKEET_STT_MODEL_PATH="$MODEL_PATH"
exec cargo run --release
