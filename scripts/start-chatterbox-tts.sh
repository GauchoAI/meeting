#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-chatterbox"

if [ ! -x "$VENV/bin/python" ]; then
  echo "[meeting-tts] missing $VENV. Run: uv venv --python 3.12 .venv-chatterbox && . .venv-chatterbox/bin/activate && uv pip install chatterbox-tts" >&2
  exit 1
fi

exec "$VENV/bin/python" "$ROOT/scripts/chatterbox-tts-server.py"
