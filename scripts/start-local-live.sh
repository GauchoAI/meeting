#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WAIT_SECONDS="${MEETING_START_WAIT_SECONDS:-180}"
FORCE_RESTART=0

usage() {
  cat <<'EOF'
Usage: scripts/start-local-live.sh [--restart]

Starts the source Meeting app plus the local live speech stack:
  - web stable shell on http://localhost:5175/stable.html
  - API on http://localhost:4317
  - MLX Voxtral TTS on http://127.0.0.1:8792
  - Parakeet STT on http://127.0.0.1:8793

Without --restart, already-running services are left alone.
With --restart, existing Meeting local-live ports and screen sessions are reset.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart)
      FORCE_RESTART=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v screen >/dev/null 2>&1; then
  echo "Missing required command: screen" >&2
  exit 1
fi

mkdir -p .meeting

port_is_listening() {
  local port="$1"
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
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

stop_screen() {
  local name="$1"
  screen -S "$name" -X quit >/dev/null 2>&1 || true
}

start_screen() {
  local name="$1"
  local command="$2"
  stop_screen "$name"
  screen -dmS "$name" bash -lc "cd $(printf '%q' "$ROOT") && exec $command"
}

wait_for_port() {
  local port="$1"
  local label="$2"
  local start
  start="$(date +%s)"
  while ! port_is_listening "$port"; do
    if (( "$(date +%s)" - start >= WAIT_SECONDS )); then
      echo "Timed out waiting for $label on port $port" >&2
      return 1
    fi
    sleep 1
  done
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local start
  start="$(date +%s)"
  while ! curl -fsS "$url" >/dev/null 2>&1; do
    if (( "$(date +%s)" - start >= WAIT_SECONDS )); then
      echo "Timed out waiting for $label at $url" >&2
      return 1
    fi
    sleep 1
  done
}

# Shut down the copied-runtime LaunchAgent if it is installed. Source dev runs
# directly from this checkout so changes and speech routes match the repo.
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.gaucho.meeting.plist" >/dev/null 2>&1 || true

if (( FORCE_RESTART )); then
  stop_screen meeting-dev
  stop_screen meeting-voxtral-tts
  stop_screen meeting-parakeet-stt
  for port in 5173 5175 4317 8792 8793; do
    kill_port "$port"
  done
  sleep 1
fi

if ! port_is_listening 5175 || ! port_is_listening 4317; then
  # If the copied runtime is still bound to the old dev port, clear it before
  # starting the canonical source checkout on 5175/4317.
  kill_port 5173
  kill_port 5175
  kill_port 4317
  start_screen meeting-dev "pnpm dev > /tmp/meeting-source-dev.log 2>&1"
fi

if ! port_is_listening 8792; then
  start_screen meeting-voxtral-tts "scripts/start-voxtral-mlx-tts.sh > .meeting/voxtral-mlx-tts.log 2>&1"
fi

if ! port_is_listening 8793; then
  start_screen meeting-parakeet-stt "scripts/start-parakeet-stt-server.sh > .meeting/parakeet-stt.log 2>&1"
fi

wait_for_port 5175 "Meeting web"
wait_for_port 4317 "Meeting API"
wait_for_port 8792 "MLX Voxtral TTS"
wait_for_port 8793 "Parakeet STT"
wait_for_http "http://127.0.0.1:4317/health" "Meeting API health"
wait_for_http "http://127.0.0.1:8793/health" "Parakeet STT health"

cat <<EOF
Meeting local-live stack is running.

Open:
  http://localhost:5175/stable.html

Use:
  Click "Join meeting", then hold Space to speak.

Logs:
  /tmp/meeting-source-dev.log
  .meeting/voxtral-mlx-tts.log
  .meeting/parakeet-stt.log

Smoke checks:
  curl http://127.0.0.1:4317/health
  curl http://127.0.0.1:8793/health
  curl -D - -o /tmp/meeting-tts-smoke.wav -X POST http://127.0.0.1:4317/tts/synthesize -H 'content-type: application/json' --data '{"text":"Meeting speech smoke test."}'

Stop:
  scripts/stop-local-live.sh
EOF
