#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ROOT="${MEETING_RUNTIME_ROOT:-$HOME/Library/Application Support/GauchoAI/meeting/runtime}"

mkdir -p "$RUNTIME_ROOT"

rsync -a --delete \
  --exclude ".git" \
  --exclude ".meeting" \
  --exclude "node_modules" \
  --exclude "apps/*/node_modules" \
  --exclude "packages/*/node_modules" \
  --exclude "apps/web/dist" \
  --exclude "apps/web/public/stable.html" \
  "$ROOT/" "$RUNTIME_ROOT/"

echo "[meeting] synced source to runtime: $RUNTIME_ROOT"
