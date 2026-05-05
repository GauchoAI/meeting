#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${MEETING_API_URL:-http://localhost:4317}"
MEETING_ID="${MEETING_ID:-local-demo}"

if command -v codex >/dev/null 2>&1; then
  codex mcp remove meeting >/dev/null 2>&1 || true
  codex mcp add meeting \
    --env "MEETING_API_URL=$API_URL" \
    --env "MEETING_ID=$MEETING_ID" \
    --env "MEETING_AGENT_ID=${CODEX_MEETING_AGENT_ID:-codex-mcp}" \
    -- pnpm --dir "$ROOT" --filter @meeting/mcp-server dev
  echo "[meeting] installed Codex MCP server: meeting"
else
  echo "[meeting] codex CLI not found; skipped Codex MCP install"
fi

if command -v claude >/dev/null 2>&1; then
  claude mcp remove -s user meeting >/dev/null 2>&1 || true
  claude mcp add-json -s user meeting "$(node -e '
    const root = process.argv[1];
    const apiUrl = process.argv[2];
    const meetingId = process.argv[3];
    const agentId = process.env.CLAUDE_MEETING_AGENT_ID || "claude-mcp";
    console.log(JSON.stringify({
      type: "stdio",
      command: "pnpm",
      args: ["--dir", root, "--filter", "@meeting/mcp-server", "dev"],
      env: {
        MEETING_API_URL: apiUrl,
        MEETING_ID: meetingId,
        MEETING_AGENT_ID: agentId
      }
    }));
  ' "$ROOT" "$API_URL" "$MEETING_ID")"
  echo "[meeting] installed Claude Code MCP server: meeting"
else
  echo "[meeting] claude CLI not found; skipped Claude MCP install"
fi
