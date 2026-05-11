# Meeting

`meeting` is a local-first agentic meeting room. Humans meet in a browser while local agent workers listen to meeting events, raise a hand when useful, and work in selected repositories after the host grants permission.

## Start Here

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Open the stable shell:

```txt
http://localhost:5175/stable.html
```

The stable shell owns microphone permission, local speech capture, Realtime state, transcript persistence, and Pi/Codex update injection. The React app runs inside the shell iframe so normal UI hot reloads do not drop the voice session.

## Project Map

| Path | Purpose |
| --- | --- |
| `apps/api` | Local event bus, speech endpoints, artifacts, Realtime tools, and implementation queue. |
| `apps/web` | Browser meeting UI plus the stable shell in `apps/web/public/stable.html`. |
| `apps/agent-worker` | Local Codex/Claude worker scaffold that consumes meeting tasks. |
| `apps/mcp-server` | MCP server so Codex and Claude Code can post to the meeting, raise hands, and create tasks. |
| `packages/protocol` | Shared meeting event and formatting helpers. |
| `packages/transcript` | Transcript parsing and persistence helpers. |
| `packages/wiki-engine` | Local wiki/artifact planning utilities. |
| `tools/parakeet-stt-server` | Rust HTTP bridge for the local Parakeet STT model. |
| `scripts` | Local setup, daemon, speech, benchmark, and guardrail commands. See `scripts/README.md`. |
| `docs` | Architecture, operations, and provider notes. Start with `docs/README.md`. |
| `.meeting/` | Ignored runtime state: events, temporary benchmark output, generated audio, and live previews. |

## Local Speech Defaults

Committed local defaults live in `config/meeting.local.json`:

```json
{
  "speechMode": "live",
  "sttProvider": "parakeet-http",
  "liveTtsProvider": "mlx-voxtral",
  "narrationTtsProvider": "qwen3-tts"
}
```

Start the local bridges you need:

```bash
scripts/start-parakeet-stt-server.sh
scripts/start-voxtral-mlx-tts.sh
```

Run the repeatable speech benchmark:

```bash
pnpm benchmark:speech
```

Current measured recommendations are in `docs/speech-provider-benchmarks.md`.

## Useful Commands

```bash
pnpm dev
pnpm dev:api
pnpm dev:web
pnpm dev:mcp
pnpm typecheck
pnpm test:assistant-delivery
pnpm test:realtime-sleep
pnpm benchmark:speech
```

Install local daemon and MCP client config:

```bash
bash scripts/install-daemon.sh
bash scripts/install-mcp-clients.sh
```

The portable MCP endpoint is:

```txt
http://localhost:4318/mcp
```

Smoke-test it against the running meeting API:

```bash
pnpm --filter @meeting/mcp-server smoke:http
```

## Runtime Boundaries

- Browser speech synthesis is not used for Meeting speech output.
- Local speech providers keep OpenAI Realtime disabled unless `MEETING_ALLOW_OPENAI_REALTIME=true`.
- Generated benchmark audio, event logs, and live preview files belong under `.meeting/` and stay out of git.
- Durable smart artifacts are owned by Pi/Codex workflows under `artifacts/`.
- Secrets belong in `.env`, not committed config or docs.

## Documentation

Use `docs/README.md` as the index. The main operational docs are:

- `docs/reproducible-dev.md`
- `docs/stable-shell.md`
- `docs/local-voice-models.md`
- `docs/speech-provider-benchmarks.md`
- `docs/assistant-output-delivery.md`
- `docs/agent-direct-messaging.md`
