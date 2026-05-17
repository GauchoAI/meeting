#!/usr/bin/env bash
set -euo pipefail

stop_screen() {
  local name="$1"
  screen -S "$name" -X quit >/dev/null 2>&1 || true
}

kill_port() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # Intentional word splitting: lsof returns one pid per line.
    kill $pids >/dev/null 2>&1 || true
  fi
}

stop_screen meeting-dev
stop_screen meeting-voxtral-tts
stop_screen meeting-parakeet-stt

for port in 5175 4317 8792 8793; do
  kill_port "$port"
done

echo "Stopped Meeting local-live stack."
