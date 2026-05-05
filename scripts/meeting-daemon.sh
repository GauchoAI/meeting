#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-}"
if [ -z "$PNPM_BIN" ]; then
  if command -v pnpm >/dev/null 2>&1; then
    PNPM_BIN="$(command -v pnpm)"
  elif [ -x /opt/homebrew/bin/pnpm ]; then
    PNPM_BIN="/opt/homebrew/bin/pnpm"
  else
    echo "[meeting] pnpm not found" >&2
    exit 127
  fi
fi

cd "$ROOT"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

"$PNPM_BIN" --silent --filter @meeting/api dev &
pids+=("$!")

"$PNPM_BIN" --silent --filter @meeting/mcp-server http &
pids+=("$!")

"$PNPM_BIN" --silent --filter @meeting/web dev &
pids+=("$!")

wait "${pids[@]}"
