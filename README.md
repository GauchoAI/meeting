# Meeting

`meeting` is a local-first agentic meeting room.

Humans meet in a browser. Local Codex and Claude workers listen to transcript
events, raise a hand when useful, and can work in selected repositories after
the host grants permission.

## First Milestone

- P2P-ready meeting UI with transcript and agent side panel.
- Local API event bus.
- Local Whisper speech-to-text through `whisper.cpp`.
- Deepgram remains a fallback provider, not the agent brain.
- Local agent-worker scaffold for Codex or Claude subscription CLIs.
- MCP server so Claude Code / Codex can post Markdown, raise hands, set
  repository context, and create visible task cards.

## Setup

```bash
pnpm install
cp .env.example .env
bash scripts/install-daemon.sh
bash scripts/install-mcp-clients.sh
```

Open `http://localhost:5173`.

For the Realtime voice-to-Codex demo added in this repo, open
`http://localhost:5173/realtime.html` after setting `OPENAI_API_KEY` in `.env`.
That path creates a browser WebRTC session to OpenAI Realtime, exposes local
tools for shell/Codex work, and lets the agent rewrite a live
`.meeting/realtime/index.html` preview rendered in an iframe.

The app expects real local audio. There is no mock transcript loop in the
default product path.

## Local Whisper

Install `whisper.cpp` and the multilingual small model:

```bash
bash scripts/setup-whisper.cpp.sh
```

Then start the app:

```bash
pnpm dev
```

In the UI, click **Start Whisper** to send short microphone chunks to the local
API. The API converts browser audio with `ffmpeg` and invokes `whisper-cli`.

## Realtime Codex Demo

The default Meeting product path remains local-first Whisper plus meeting
events. There is also a separate experimental demo entrypoint for a direct
OpenAI Realtime voice session:

```bash
pnpm dev
open http://localhost:5173/realtime.html
```

What it does:

- opens a WebRTC audio call to `gpt-realtime-2`;
- keeps your local camera visible in the page, but does not send video to the model;
- exposes browser-triggered tools that can run short shell commands in the
  workspace, queue `pi-agent` implementation work, and rewrite
  `.meeting/realtime/index.html`;
- reloads the iframe preview whenever the agent publishes new HTML.

This is intended as a local demo. The shell bridge has basic blocking for
obviously destructive commands, but it should still be treated as a trusted
developer tool, not a production-safe remote execution surface.

## Realtime Listener Mode

The main Meeting UI at `http://localhost:5173/` now supports a Realtime agent
in the existing layout.

Behavior:

- the Realtime agent connects as a **silent background listener** by default;
- room speech is transcribed and persisted into `.meeting/events.jsonl` and
  `.meeting/session.md`;
- the agent can silently react by raising a hand, posting Markdown, creating
  task cards, inspecting the repo, or queueing implementation work for
  `pi-agent`;
- `pi-agent` consumes `.meeting/pipeline/implementation/tasks/queued/*` and
  invokes local Codex, keeping implementation work in a visible lifecycle;
- the host can explicitly grant the floor with **Let agent speak**;
- after speaking, the agent returns to silent listening mode.

This is the preferred path for project-planning meetings where the agent should
mostly listen, think, update the live canvas, declare tasks, and only speak when
invited. Durable smart artifacts are owned by `pi-agent`, not the Realtime
conversation agent.

## MCP

The portable default is the local daemon endpoint:

```bash
http://localhost:4318/mcp
```

Smoke-test the HTTP MCP server against the running meeting API:

```bash
pnpm --filter @meeting/mcp-server smoke:http
```

Install the MCP server into local Codex and Claude Code configs:

```bash
bash scripts/install-mcp-clients.sh
```

Then restart Codex or Claude sessions so the new `meeting` tools are mounted in
the model context.

Tools:

- `meeting_raise_hand`
- `meeting_post_markdown`
- `meeting_set_repository`
- `meeting_create_task`

Agent output should usually be Markdown. Mermaid blocks render live:

````markdown
```mermaid
flowchart LR
  Human --> Transcript
  Transcript --> Agent
  Agent --> UI
```
````

Example MCP client configuration:

```json
{
  "mcpServers": {
    "meeting": {
      "url": "http://localhost:4318/mcp"
    }
  }
}
```
