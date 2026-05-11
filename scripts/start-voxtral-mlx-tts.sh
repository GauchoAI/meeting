#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VOXTRAL_MLX_TTS_VENV:-"$ROOT/.venv-voxtral-tts"}"
PY="$VENV/bin/python"
HOST="${VOXTRAL_MLX_TTS_HOST:-127.0.0.1}"
PORT="${VOXTRAL_MLX_TTS_PORT:-8792}"
export HF_HUB_DISABLE_XET="${HF_HUB_DISABLE_XET:-1}"

if [[ ! -x "$PY" ]]; then
  python3 -m venv "$VENV"
fi

"$PY" - <<'PY' || "$PY" -m pip install -U pip wheel 'setuptools<81' mlx-audio fastapi uvicorn webrtcvad python-multipart 'mistral-common[audio]'
import importlib
for name in ("mlx_audio", "fastapi", "uvicorn", "webrtcvad", "mistral_common"):
    importlib.import_module(name)
PY

cd "$ROOT"
exec "$PY" -m mlx_audio.server --host "$HOST" --port "$PORT"
