#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="ai.gaucho.meeting"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/meeting"
RUNTIME_ROOT="$HOME/Library/Application Support/GauchoAI/meeting/runtime"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$RUNTIME_ROOT"

rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "apps/*/node_modules" \
  --exclude "packages/*/node_modules" \
  --exclude "apps/web/dist" \
  "$ROOT/" "$RUNTIME_ROOT/"

(cd "$RUNTIME_ROOT" && /opt/homebrew/bin/pnpm install --frozen-lockfile)

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNTIME_ROOT/scripts/meeting-daemon.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$RUNTIME_ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "[meeting] installed launchd daemon: $LABEL"
echo "[meeting] runtime: $RUNTIME_ROOT"
echo "[meeting] API: http://localhost:4317"
echo "[meeting] MCP: http://localhost:4318/mcp"
echo "[meeting] UI:  http://localhost:5173"
