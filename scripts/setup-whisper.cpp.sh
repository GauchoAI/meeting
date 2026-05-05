#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/models"

if ! command -v whisper-cli >/dev/null 2>&1; then
  echo "[meeting] installing whisper-cpp with Homebrew"
  brew install whisper-cpp
fi

if [ ! -f "$ROOT/models/ggml-small.bin" ]; then
  echo "[meeting] downloading multilingual ggml-small model"
  curl -L \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin" \
    -o "$ROOT/models/ggml-small.bin"
fi

echo "[meeting] whisper-cli: $(command -v whisper-cli)"
echo "[meeting] model: $ROOT/models/ggml-small.bin"

