#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Stop the copied-runtime daemon. During development we run directly from this
# checkout so Vite/tsx watch the canonical source instead of an rsync mirror.
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.gaucho.meeting.plist" >/dev/null 2>&1 || true

# Stop old background dev process if this script launched one before.
if [ -f /tmp/meeting-source-dev.pid ]; then
  kill "$(cat /tmp/meeting-source-dev.pid)" >/dev/null 2>&1 || true
  rm -f /tmp/meeting-source-dev.pid
fi

# Stop the runtime sync loop if it is running.
if [ -f /tmp/meeting-runtime-sync.pid ]; then
  kill "$(cat /tmp/meeting-runtime-sync.pid)" >/dev/null 2>&1 || true
  rm -f /tmp/meeting-runtime-sync.pid
fi

lsof -tiTCP:5173 -sTCP:LISTEN | xargs -r kill >/dev/null 2>&1 || true
lsof -tiTCP:4317 -sTCP:LISTEN | xargs -r kill >/dev/null 2>&1 || true

nohup pnpm dev > /tmp/meeting-source-dev.log 2>&1 &
echo $! > /tmp/meeting-source-dev.pid

echo "[meeting] source dev server started from $ROOT"
echo "[meeting] log: /tmp/meeting-source-dev.log"
echo "[meeting] UI:  http://localhost:5173/stable.html"
