#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PNPM_BIN="${PNPM_BIN:-$(command -v pnpm)}"

cd "$ROOT"
exec "$PNPM_BIN" --silent --filter @meeting/mcp-server exec tsx src/server.ts
