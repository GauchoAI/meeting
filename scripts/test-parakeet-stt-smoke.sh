#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="${PARAKEET_STT_URL:-http://127.0.0.1:8793/transcribe}"
TMP_DIR="${MEETING_STT_SMOKE_DIR:-"$ROOT/.meeting/tmp/stt-smoke"}"
mkdir -p "$TMP_DIR"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

has_voice() {
  say -v '?' | awk '{print $1}' | grep -Fxq "$1"
}

transcribe_sample() {
  local label="$1"
  local voice="$2"
  local phrase="$3"
  local slug="$4"
  local aiff="$TMP_DIR/$slug.aiff"
  local wav="$TMP_DIR/$slug.wav"

  if ! has_voice "$voice"; then
    echo "[$label] skipped: macOS voice '$voice' is not installed"
    return 0
  fi

  say -v "$voice" "$phrase" -o "$aiff"
  ffmpeg -hide_banner -loglevel error -y -i "$aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$wav"

  local response
  response="$(curl -sS --fail -X POST --data-binary @"$wav" "$URL?extension=wav")"
  local text
  text="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("text", ""))' <<<"$response")"
  echo "[$label] $text"
}

require_command say
require_command ffmpeg
require_command curl
require_command python3

transcribe_sample \
  "Russian" \
  "Milena" \
  "Здравствуйте. Меня зовут Милена. Я говорю по-русски. Сегодня мы проверяем распознавание русской речи." \
  "russian-milena"

transcribe_sample \
  "Spanish" \
  "Mónica" \
  "Hola, mi nombre es Mónica. Estoy hablando en español. Hoy estamos probando el reconocimiento de voz para una reunión de software." \
  "spanish-monica"
