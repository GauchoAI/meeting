#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="$(mktemp -t meeting-sync-marker.XXXXXX)"
trap 'rm -f "$MARKER"' EXIT

cd "$ROOT"

bash scripts/sync-runtime.sh
touch "$MARKER"

echo "[meeting] watching source and syncing to runtime without restarting UI"

while true; do
  if find \
    apps packages config scripts .pi \
    package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json README.md \
    -type f -newer "$MARKER" \
    ! -path '*/node_modules/*' \
    ! -path '*/.git/*' \
    ! -path '*/.meeting/*' \
    -print -quit 2>/dev/null | grep -q .; then
    bash scripts/sync-runtime.sh
    touch "$MARKER"
  fi
  sleep 1
 done
