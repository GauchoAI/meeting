#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_URL="${MEETING_MCP_URL:-http://localhost:4318/mcp}"

if command -v codex >/dev/null 2>&1; then
  codex mcp remove meeting >/dev/null 2>&1 || true
  codex mcp add meeting --url "$MCP_URL"
  echo "[meeting] installed Codex MCP server: meeting"
else
  echo "[meeting] codex CLI not found; skipped Codex MCP install"
fi

if command -v claude >/dev/null 2>&1; then
  claude mcp remove -s user meeting >/dev/null 2>&1 || true
  claude mcp add --scope user --transport http meeting "$MCP_URL"
  echo "[meeting] installed Claude Code MCP server: meeting"
else
  echo "[meeting] claude CLI not found; skipped Claude MCP install"
fi
