#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${QWEN3_TTS_VENV:-"$ROOT/.venv-qwen3-tts"}"
HOST="${QWEN3_TTS_HOST:-127.0.0.1}"
PORT="${QWEN3_TTS_PORT:-8794}"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "[meeting-qwen3-tts] missing $VENV" >&2
  echo "[meeting-qwen3-tts] install with: python3.12 -m venv .venv-qwen3-tts && .venv-qwen3-tts/bin/python -m pip install -U pip wheel 'setuptools<82' qwen-tts" >&2
  exit 1
fi

export PYTORCH_ENABLE_MPS_FALLBACK="${PYTORCH_ENABLE_MPS_FALLBACK:-1}"
export QWEN3_TTS_HOST="$HOST"
export QWEN3_TTS_PORT="$PORT"

exec "$VENV/bin/python" "$ROOT/scripts/qwen3-tts-server.py"
