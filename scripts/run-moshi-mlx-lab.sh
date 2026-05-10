#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${MOSHI_MLX_VENV:-$ROOT/.venv-moshi-mlx}"

if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -U pip
python -m pip install -U moshi_mlx

echo "[meeting] starting Moshi MLX local web lab"
echo "[meeting] model: ${MOSHI_MLX_REPO:-kyutai/moshika-mlx-bf16}"
python -m moshi_mlx.local_web --hf-repo "${MOSHI_MLX_REPO:-kyutai/moshika-mlx-bf16}"
