# Meeting Project Architecture

`meeting` is a **local-first agentic meeting room**. Humans meet in a browser, speech becomes transcript events, local agents observe the event stream, and approved tools let agents create artifacts, render diagrams, search the local wiki, and work in repositories.

## 1) System at a glance

```mermaid
flowchart LR
  Human[Human host / participants] --> Web[apps/web\nBrowser meeting UI]
  Web --> API[apps/api\nLocal API + event bus]
  API --> Transcript[packages/transcript\nTranscript events]
  API --> Whisper[Local Whisper / whisper.cpp]
  API --> Deepgram[Deepgram fallback]

  Transcript --> Worker[apps/agent-worker\nCodex / Claude workers]
  Worker --> MCP[apps/mcp-server\nMeeting MCP tools]
  MCP --> API

  MCP --> Artifacts[Smart-down artifacts\nartifacts/dt=.../hour=...]
  MCP --> Wiki[packages/wiki-engine\nLocal wiki / retrieval layer]
  MCP --> Repo[Selected repository\nwith host permission]

  Artifacts --> Render[Rendered side panel\nMarkdown + Mermaid + images]
  Wiki --> Search[Artifact/wiki search index]
  Search --> Worker

  classDef human fill:#fef3c7,stroke:#92400e,color:#0f172a;
  classDef app fill:#dbeafe,stroke:#1d4ed8,color:#0f172a;
  classDef data fill:#dcfce7,stroke:#166534,color:#0f172a;
  classDef tool fill:#ede9fe,stroke:#6d28d9,color:#0f172a;
  classDef external fill:#fee2e2,stroke:#b91c1c,color:#0f172a;

  class Human human;
  class Web,API,Worker,MCP app;
  class Transcript,Artifacts,Wiki,Search,Render data;
  class Repo tool;
  class Deepgram,Whisper external;
```

## 2) Main workspace components

| Area | Path | Role |
|---|---|---|
| Web UI | `apps/web` | Browser meeting room, transcript display, artifact rendering side panel |
| Local API | `apps/api` | Local event bus, speech endpoints, server-side coordination |
| Agent worker | `apps/agent-worker` | Local Codex/Claude-style workers that listen and act when useful |
| MCP server | `apps/mcp-server` | Tool bridge exposed to coding agents and assistants |
| Protocol package | `packages/protocol` | Shared event/tool contracts between apps |
| Transcript package | `packages/transcript` | Transcript data structures and speech-event handling |
| Wiki engine | `packages/wiki-engine` | Local-first memory layer, search, parent/child traversal |
| Artifacts | `artifacts/dt=YYYY-MM-DD/hour=HH/...` | Durable smart Markdown outputs with manifests |
| Scripts | `scripts/` | Dev, daemon, screenshot, artifact, and rendering utilities |

## 3) Runtime conversation loop

```mermaid
sequenceDiagram
  participant H as Host
  participant W as Browser UI
  participant A as Local API
  participant T as Transcript/Event Bus
  participant G as Agent Worker
  participant M as MCP Server
  participant S as Smart Artifact Store

  H->>W: Speaks / types request
  W->>A: Sends audio chunks or message
  A->>T: Emits transcript and meeting events
  T->>G: Agent observes context
  G->>G: Decides whether to respond or raise hand
  G->>M: Calls Meeting tools when needed
  M->>S: Create/edit/open artifact
  S-->>W: Render latest artifact in side panel
  G-->>H: Concise spoken/chat response
```

## 4) Artifact lifecycle

Smart-down artifacts are durable Markdown documents. One folder represents one evolving idea; normal iterations edit the same `artifact.smart.md` rather than creating `v2` files.

```mermaid
flowchart TB
  Request[Host request] --> Intent{Artifact intent?}
  Intent -->|new topic| Create[meeting_write_artifact]
  Intent -->|existing topic| Search[meeting_find_artifact / artifactIndex]
  Intent -->|edit current| Edit[Read + precise edit]
  Intent -->|open/show| Open[meeting_open_artifact]

  Create --> Folder[artifacts/dt=.../hour=.../kind-slug/]
  Folder --> Smart[artifact.smart.md]
  Folder --> Manifest[manifest.json]
  Smart --> Render[Meeting side-panel render]
  Manifest --> Index[artifacts/index.json]
  Search --> Open
  Edit --> Smart
  Open --> Render

  classDef action fill:#dbeafe,stroke:#1d4ed8,color:#0f172a;
  classDef decision fill:#fef3c7,stroke:#92400e,color:#0f172a;
  classDef store fill:#dcfce7,stroke:#166534,color:#0f172a;

  class Request,Create,Search,Edit,Open action;
  class Intent decision;
  class Folder,Smart,Manifest,Index,Render store;
```

## 5) Retrieval and wiki architecture

The project uses two related memory ideas:

1. **Artifacts** — polished, durable outputs with `manifest.json` metadata and a generated index.
2. **Wiki engine** — a local-first graph of pages with parent/child references, compact summaries, keywords, and deterministic traversal.

```mermaid
flowchart LR
  Query[User asks for something] --> Candidates[Ranked candidates\nartifactIndex + search]
  Candidates --> Intent[Intent router\nopen / edit / create / chat]
  Intent --> Existing[Open or edit existing artifact]
  Intent --> New[Create separate artifact]

  Raw[raw documents] --> Extract[Extract title, summary, keywords, entities]
  Extract --> Parent[Choose parent page\noptional LLM arbitration]
  Parent --> Page[Generated wiki page]
  Page --> Backlink[Parent menu/backlink update]
  Backlink --> Traverse[Numbered traversal\n[0] parent, [1..n] children]

  Page --> Candidates
  Existing --> Render[Rendered answer/artifact]
  New --> Render

  classDef query fill:#fef3c7,stroke:#92400e,color:#0f172a;
  classDef process fill:#dbeafe,stroke:#1d4ed8,color:#0f172a;
  classDef memory fill:#dcfce7,stroke:#166534,color:#0f172a;
  classDef output fill:#ede9fe,stroke:#6d28d9,color:#0f172a;

  class Query,Intent query;
  class Candidates,Extract,Parent,Backlink process;
  class Raw,Page,Traverse memory;
  class Existing,New,Render output;
```

## 6) Tooling surface

The assistant-facing tools map closely onto project operations:

- **Create artifact**: `meeting_write_artifact`
- **Find artifact**: `meeting_find_artifact`
- **Open artifact**: `meeting_open_artifact`
- **Inspect render**: `meeting_inspect_artifact`
- **Queue visual review**: `meeting_queue_visual_review`
- **Promote diagram image**: `meeting_promote_diagram_image`
- **File-level work**: read/edit/write/bash inside the repository

## 7) Design principles

- **Local-first**: core meeting, transcript, artifact, and wiki flows run locally.
- **Durable memory**: artifacts and wiki pages are files, not hidden chat state.
- **Human permission boundary**: agents can observe, propose, and act through approved tools.
- **Renderable by default**: Markdown, Mermaid, and promoted images keep outputs visible.
- **Iterate in place**: existing artifacts evolve; Git history provides versioning.

## 8) Current strength and next improvement

The strongest part of the architecture is the loop from **conversation → intent → tool call → durable artifact → rendered UI**.

The next improvement would be stronger retrieval ergonomics: better fuzzy names, aliases like “the Napoleon one,” snippets in candidate results, and explicit clarification when confidence is low.
