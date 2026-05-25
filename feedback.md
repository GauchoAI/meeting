# feedback

Running log of structural feedback on the `meeting` project.
One entry per review pass. Newest at the top.

---

## 2026-05-24 — distribution / headless host

Reviewer: Claude (Opus 4.7), with Miguel.
Scope: surfaced while bringing up the full stack end-to-end and trying the GitHub Pages lobby.

### Observations from actually running it

- The one-script flow now works (`scripts/start-local-live.sh` brings up API + web + Voxtral + Parakeet + Firebase advertiser + Pi in a detached screen).
- Pi must be running for the voice loop to close — the agent-worker labels itself `pi-agent` but only consumes the implementation queue; the actual brain is the `pi` CLI plus `.pi/extensions/meeting/`.
- The Firebase lobby IS receiving the advertised meeting (verified at `signaling-dcfad-...firebasedatabase.app/gauchoai-meeting/publicMeetings/core.json`); the lobby code passes CORS, the deployed bundle has the right URL constants, the record passes the 45s freshness filter.
- The friction Miguel wants gone: requiring a host browser tab (`localhost:5175/stable.html`) to be open in order for the Pages site to be useful. With `peerOnly=1` the Pages tab is a passive WebRTC peer waiting for a host browser somewhere; without a host tab the meeting has no bridge to the local API.

### The architectural ask, in Miguel's words

> "If I will just at any point open the GitHub page and it will just work for my computer, for my friend's computer as long as I have my Pi-agent working here, it should work."

The current architecture (`docs/multi-human-webrtc.md:71-81`) deliberately makes the host *browser* the bridge between WebRTC peers and the local API/model stack, to avoid requiring a tunnel for guests. That choice trades guest-side simplicity (no tunnel) for host-side weight (one browser tab must always be open and joined).

### Proposals

1. **Short-term unblock — tunnel + drop `peerOnly`.** Run a Cloudflare Tunnel (or ngrok) `https://your-tunnel.example` → `http://localhost:4317`. Advertise the tunneled URL as `apiUrl`. Anyone opens `https://gauchoai.github.io/meeting/stable.html?api=<tunnel>&meeting=core` (no `peerOnly`), and each browser is its own host directly against the tunneled stack. No localhost tab needed.
   - **Why:** matches Miguel's desired experience right now, with no code change.
   - **How to apply:** add a `scripts/start-tunnel.sh` (or fold into `start-local-live.sh` behind `MEETING_LIVE_TUNNEL=true`) that boots the tunnel, captures the HTTPS URL, and passes it as `--api` to `advertise-meeting.mjs`.

2. **Architectural fix — headless host.** Move the audio pipeline + WebRTC peer responsibility out of `apps/web/public/stable.html` and into `apps/api` (or Pi). The API runs a Node WebRTC peer (e.g. `wrtc` / `@roamhq/wrtc`) so guest browsers can WebRTC-peer directly to the *machine*, not to another browser. Browsers become pure clients; nothing has to be open locally beyond the API + Pi.
   - **Why:** removes the "must keep a tab open" friction permanently and makes the Pages lobby actually self-sufficient as a public entry point.
   - **How to apply:** new module `apps/api/src/webrtc-peer.ts`; wire it to the existing `/audio/chunk` and TTS broadcast paths so audio in/out flows through it. Update `multi-human-webrtc.md` since this directly revises section "Correct objective: Peer/WebRTC + Firebase signaling".
   - **Risk:** real refactor — days of work, touches the live voice path. Needs the existing `test:stable-voice` smoke + a new headless-peer smoke before it's safe to land.

3. **Doc hygiene at the same time.** `docs/multi-human-webrtc.md` should call out the current "host browser tab required" reality explicitly. Right now the doc reads as if Firebase + WebRTC alone is enough; in practice you also need a host browser somewhere. New readers will hit the same friction Miguel did.

### Tradeoff

The short-term tunnel fix is fast but adds an ops dependency (a tunnel process and either an ephemeral ngrok URL or Cloudflare DNS). The headless-host refactor is the right destination but it's a multi-day refactor on the most fragile part of the system. Realistic sequence: tunnel now, headless host as the next named milestone, and bias against any UI work in the stable shell until the headless work decides what stays in the browser.

### Smaller items also noticed while running

- `scripts/start-local-live.sh` previously did NOT start the advertiser or Pi — adding those was needed to make "one script" actually mean "one script." Now done locally; should be committed.
- The advertiser logs "removed core" on graceful shutdown, which leaves a brief window during `--restart` where the lobby entry is missing. Ergonomic, not blocking.
- Pi exec's to `argv[0]="pi"`, so any duplicate-detection / kill logic must match on the short name, not the full `/opt/homebrew/bin/pi` path. Easy mistake; flag in any future install/uninstall scripts.

### Two real bugs hit while testing (fixed locally; need real fixes upstream)

#### Bug A — Pi artifact-watcher feedback loop (caused ~16K duplicate canvas events; UI flicker; voice loop starved)

**Where:** `.pi/extensions/meeting/index.ts`, `publishArtifactChange` (around line 536) feeding `streamMarkdownToMeeting` (around line 549). The watcher fires on `artifact.smart.md` changes, streams the whole file line-by-line as `agent.message` drafts to the meeting, then `commitArtifactChange` git-adds + commits the same file. Whatever was re-touching the artifact file after a turn (no canonical observation of which path, but suspect `meeting_write_artifact` rewriting the same content, or a side effect of the commit/diff path) triggered the watcher again → re-stream → ~16K identical drafts before anyone caught it. Pi was too busy publishing to answer new utterances; the host UI flickered because each draft re-rendered the canvas.

**Local fix applied:** added a `lastPublishedArtifactContent` map keyed by path; `publishArtifactChange` now skips when the content is identical to the previously published version. After `IDENTICAL_PUBLISH_LIMIT = 3` consecutive identical re-fires for the same path, the watcher closes itself and emits an `error` trace. Trace channel: `debug` for skips, `error` for the kill-switch.

**Why this is the right shape, but probably not the right *home*:** the real fix should make the rewrite path itself idempotent — `publishArtifactChange` should not be the one deciding "this is a duplicate" because it's downstream of the real issue (someone *wrote the same content*). A proper fix would short-circuit the write earlier: e.g. `meeting_write_artifact` reads-then-writes only on diff. Or the commit path stops if the working tree is unchanged. Either way the watcher should stay innocent. The applied guard is defense in depth.

**Reproduction hint:** trigger a turn that calls `meeting_write_artifact` more than once for the same slug in the same turn, or any flow that runs `commitArtifactChange` while the watcher is hot. Add a unit test that asserts: N consecutive `publishArtifactChange` calls with the same markdown → exactly 1 stream call.

#### Bug B — Agent-worker crashes on `events.jsonl` past 2 GiB

**Where:** `apps/agent-worker/src/worker.ts`, `readAppendedLines` (was around line 549) and `fileSize` (just below it). Both used `readFileSync(path)` which Node throws `ERR_FS_FILE_TOO_LARGE` on for files ≥ 2 GiB (`File size (2147928506) is greater than 2 GiB`). One bad streaming-loop turn (Bug A) drove `.meeting/events.jsonl` from ~924 MB to ~2.4 GiB, after which the worker crashlooped on every poll.

**Local fix applied:** rewrote `readAppendedLines` to use `openSync` + `readSync` with a positional read from `offset`. Caps any single read at 8 MiB — if more data has accumulated since the last poll, we tail it (read the last 8 MiB) and drop the partial leading line. `fileSize` switched from `readFileSync(...).byteLength` to `statSync(path).size`. Added imports for `closeSync`, `openSync`, `readSync`, `statSync`.

**Why the *real* problem is upstream:** the agent-worker shouldn't have to be defensive about a runaway producer. But it does need to survive one. Two follow-ups belong in the API itself:

1. **Rotate `events.jsonl`.** Once it crosses, say, 100 MiB, the writer should close + rename to `events.jsonl.<isoStamp>` and open a fresh file. Readers that consume from offset get a "rotated" signal; the agent-worker already resets offset when `offset > size`, so a rename-and-truncate strategy works with the current reader behavior.
2. **Sanity-cap streaming agent.message bursts at the API.** If the same `documentId` + `lifecycle=draft` text is posted N times in a window, the API should drop subsequent posts and emit an `error` trace. That stops Bug A from compounding into Bug B regardless of which client misbehaves.

**Cleanup needed once:** `.meeting/events.jsonl` and `.meeting/pipeline/conversation/events.jsonl` are still 2.3-2.4 GiB on disk. They no longer break things (the new reader tail-reads), but they're wasting space. Safe cleanup is: stop the stack → rename both to `*.archived.jsonl.gz` (gzip if you care about size, plain rename if you don't) → restart. Don't truncate while the API is running — it has them open for append.

---

## 2026-05-24 — first structural pass

Reviewer: Claude (Opus 4.7)
Scope: top-level shape, apps/, packages/, scripts/, docs/, runtime dirs.

### What works
- Clear README with quickstart, project map, runtime boundaries.
- `docs/` has 20 files with a recommended reading order in `docs/README.md`.
- pnpm monorepo split (`apps/{api,web,agent-worker,mcp-server}` + `packages/{protocol,transcript,wiki-engine}`) is clean.
- Real smoke tests + benchmark: `test:assistant-delivery`, `test:realtime-sleep`, `test:stable-voice`, `benchmark:speech`.
- Zero TODO/FIXME/HACK markers across `apps`, `packages`, `scripts` — disciplined.
- Local-first stance is committed in code: `config/meeting.local.json` defaults + `MEETING_ALLOW_OPENAI_REALTIME` gate.

### Proposals

1. **Split the three god files.** Highest-leverage refactor.
   - `apps/api/src/server.ts` — 2,137 lines. README already names the seams: events bus / speech endpoints / artifacts / Realtime tools / implementation queue. Split along those.
   - `apps/web/src/main.tsx` — 3,259 lines.
   - `apps/web/public/stable.html` — 3,097 lines (the mic/voice-owning shell).
   Do `server.ts` first, behind the existing `test:assistant-delivery` and `test:stable-voice` smoke tests, one route group per commit.

2. **Prune the speech-provider graveyard in `scripts/`.** The benchmark has picked winners (parakeet STT, mlx-voxtral live TTS, qwen3 narration) and they are committed in `config/meeting.local.json`. The losing launchers still litter `scripts/`:
   - `start-chatterbox-tts.sh` / `chatterbox-tts-server.py`
   - `voxtral-transformers-server.py`
   - `start-whisper-server.sh` / `setup-whisper.cpp.sh`
   - `run-moshi-mlx-lab.sh`
   Either delete or move under `scripts/experimental/`. Same call for the two committed-name venvs at repo root: `.venv-qwen3-tts`, `.venv-voxtral-tts`.

3. **Fix doc index drift.** `docs/README.md` has duplicate list numbers (two "3."s, two "4."s). Trivial, but a sign the hand-maintained index is drifting — worth a single sweep.

### Explicitly NOT proposed
- Do **not** collapse `.meeting/` / `.meeting-state/` / `.pi/` — they hold distinct runtime concerns (events, persisted state, pi-agent runtime). The separation is doing real work.
- Do **not** start a refactor pass that touches the live voice pipeline without the smoke tests passing first. The whole point of `stable.html` owning the mic is to survive UI hot reloads; a refactor that breaks that costs a meeting.

### Tradeoff
The setup currently works in local-live. Refactors here risk the voice pipeline. Mitigation: keep changes route-group-sized and gated on existing smoke tests; do not bundle pruning with splitting.
