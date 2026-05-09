import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, normalize, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { newEventId, nowIso, type MeetingEvent } from "@meeting/protocol";
import { speechProviderStatus } from "./speech.js";
import { loadDotEnv, loadLocalConfig } from "./env.js";
import { transcribeWithLocalWhisper } from "./local-whisper.js";

loadLocalConfig();
loadDotEnv();

const port = Number(process.env.MEETING_API_PORT || 4317);
const meetingId = process.env.MEETING_ID || "local-demo";
const eventLogPath = resolveRepoPath(process.env.MEETING_EVENT_LOG || ".meeting/events.jsonl");
const sessionLogPath = resolveRepoPath(".meeting/session.md");
const realtimeArtifactRoot = resolveRepoPath(".meeting/realtime");
const realtimeArtifactPath = resolve(realtimeArtifactRoot, "index.html");
const repoRoot = resolveRepoPath(".");
const workspaceRoot = resolveRepoPath(process.env.MEETING_WORKSPACE_ROOT || ".");
const events: MeetingEvent[] = [];
const sseClients = new Set<ServerResponse>();

loadEventLog();
if (!events.length) seedSystemEvent();

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    return sendCors(res, 204);
  }
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, { ok: true, meetingId, events: events.length, speech: speechProviderStatus() });
  }
  if (req.method === "GET" && url.pathname === "/events") {
    const since = Number(url.searchParams.get("since") || 0);
    return sendJson(res, { events: events.slice(since), next: events.length });
  }
  if (req.method === "GET" && url.pathname === "/events/stream") {
    return attachSse(req, res);
  }
  if (req.method === "GET" && url.pathname.startsWith("/artifacts/")) {
    return sendArtifactFile(url.pathname, res);
  }
  if (req.method === "GET" && url.pathname.startsWith("/realtime-artifacts/")) {
    return sendRealtimeArtifactFile(url.pathname, res);
  }
  if (req.method === "POST" && url.pathname === "/events") {
    const event = await readJson<MeetingEvent>(req);
    appendEvent(event);
    return sendJson(res, { ok: true, next: events.length });
  }
  if (req.method === "POST" && url.pathname === "/realtime/call") {
    const payload = await readJson<{ sdp?: string }>(req);
    return createRealtimeCall(payload.sdp || "", res);
  }
  if (req.method === "POST" && url.pathname === "/realtime/tool") {
    const payload = await readJson<{ name?: string; arguments?: unknown }>(req);
    return runRealtimeTool(payload.name || "", payload.arguments, res);
  }
  if (req.method === "POST" && url.pathname === "/audio/chunk") {
    const extension = url.searchParams.get("extension") || "webm";
    const speakerLabel = url.searchParams.get("speaker") || "Host";
    const clientStartedAt = Number(url.searchParams.get("clientStartedAt") || 0) || undefined;
    const receivedAt = Date.now();
    const audio = await readBuffer(req);
    const uploadReadAt = Date.now();
    appendTrace("latency", "audio.upload.received", { bytes: audio.length, extension, clientStartedAt, receivedAt, uploadReadAt, clientToApiMs: clientStartedAt ? receivedAt - clientStartedAt : undefined, requestReadMs: uploadReadAt - receivedAt });
    try {
      const whisperStartedAt = Date.now();
      appendTrace("latency", "whisper.start", { whisperStartedAt, bytes: audio.length, extension });
      const result = await transcribeWithLocalWhisper(audio, extension);
      const whisperEndedAt = Date.now();
      appendTrace("latency", "whisper.end", { whisperStartedAt, whisperEndedAt, whisperMs: whisperEndedAt - whisperStartedAt, reportedWhisperMs: result.elapsedMs, textChars: result.text.length });
      if (result.text && !isIgnorableTranscript(result.text)) {
        const utteranceCreatedAt = Date.now();
        const startMs = utteranceCreatedAt % 3_600_000;
        appendEvent({
          id: newEventId("utt"),
          type: "utterance.final",
          meetingId,
          createdAt: nowIso(),
          speakerId: "host",
          speakerLabel,
          text: result.text,
          startMs,
          endMs: startMs + result.elapsedMs
        });
        appendTrace("latency", "utterance.final", { utteranceCreatedAt, totalApiMs: utteranceCreatedAt - receivedAt, clientToUtteranceMs: clientStartedAt ? utteranceCreatedAt - clientStartedAt : undefined, textChars: result.text.length });
      }
      return sendJson(res, { ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendEvent({
        id: newEventId("sys"),
        type: "system",
        meetingId,
        createdAt: nowIso(),
        level: "warn",
        text: `Local Whisper transcription failed: ${message}`
      });
      return sendJson(res, { ok: false, error: message }, 500);
    }
  }
  return sendJson(res, { error: "not found" }, 404);
});

server.listen(port, () => {
  console.log(`[meeting-api] http://localhost:${port}`);
});

function appendTrace(channel: string, text: string, details?: unknown): void {
  appendEvent({
    id: newEventId("trace"),
    type: "agent.trace",
    meetingId,
    createdAt: nowIso(),
    agentId: "meeting-api",
    channel,
    text,
    details
  } as MeetingEvent);
}

function appendEvent(event: MeetingEvent, persist = true): void {
  const existingIndex = events.findIndex((candidate) => candidate.id === event.id);
  if (existingIndex >= 0) {
    events[existingIndex] = event;
  } else {
    events.push(event);
  }
  if (persist) persistEvent(event);
  const payload = `event: meeting\nid: ${events.length}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function loadEventLog(): void {
  if (!existsSync(eventLogPath)) return;
  const lines = readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as MeetingEvent);
    } catch {
      // Ignore malformed historical lines so one bad write does not prevent startup.
    }
  }
}

function persistEvent(event: MeetingEvent): void {
  mkdirSync(dirname(eventLogPath), { recursive: true });
  appendFileSync(eventLogPath, `${JSON.stringify(event)}\n`);
  appendSessionEvent(event);
}

function appendSessionEvent(event: MeetingEvent): void {
  mkdirSync(dirname(sessionLogPath), { recursive: true });
  if (!existsSync(sessionLogPath)) {
    appendFileSync(sessionLogPath, sessionHeader());
  }
  appendFileSync(sessionLogPath, formatSessionEvent(event));
}

function sessionHeader(): string {
  return [
    "# Meeting Session Log",
    "",
    "Readable transcript generated from the Meeting API event stream.",
    "",
    `Raw JSONL source: \`${eventLogPath}\``,
    "",
    "---",
    ""
  ].join("\n");
}

function formatSessionEvent(event: MeetingEvent): string {
  const actor = eventActor(event);
  const title = `## ${event.createdAt} — ${event.type} — ${actor}`;
  const body = eventBody(event);
  return `${title}\n\n${body}\n\n---\n\n`;
}

function eventActor(event: MeetingEvent): string {
  if ("agentId" in event) return event.agentId;
  if ("speakerLabel" in event) return event.speakerLabel;
  if ("level" in event) return event.level;
  return "meeting";
}

function eventBody(event: MeetingEvent): string {
  if (event.type === "utterance.final" || event.type === "utterance.partial") {
    return fencedText(event.text);
  }
  if (event.type === "agent.message") {
    const meta = [
      event.surface ? `surface: ${event.surface}` : undefined,
      event.lifecycle ? `lifecycle: ${event.lifecycle}` : undefined,
      typeof event.streaming === "boolean" ? `streaming: ${event.streaming}` : undefined,
      event.documentId ? `documentId: ${event.documentId}` : undefined
    ].filter(Boolean).join("\n");
    return [meta ? `\`\`\`yaml\n${meta}\n\`\`\`` : "", fencedText(event.text)].filter(Boolean).join("\n\n");
  }
  if (event.type === "agent.trace") {
    const trace = [
      `channel: ${event.channel}`,
      "",
      fencedText(event.text),
      event.details === undefined ? "" : `\n<details>\n<summary>details</summary>\n\n\`\`\`json\n${safeJson(event.details)}\n\`\`\`\n\n</details>`
    ].join("\n");
    return trace.trim();
  }
  if (event.type === "agent.task") {
    return [
      `status: ${event.status}`,
      `title: ${event.title}`,
      event.taskClass ? `taskClass: ${event.taskClass}` : undefined,
      event.details ? fencedText(event.details) : undefined
    ].filter(Boolean).join("\n");
  }
  if (event.type === "agent.hand_raise") {
    return [`requestedMode: ${event.requestedMode}`, `confidence: ${event.confidence}`, fencedText(event.reason)].join("\n");
  }
  if (event.type === "agent.floor") {
    return [`granted: ${event.granted}`, `mode: ${event.mode}`, event.note ? fencedText(event.note) : undefined].filter(Boolean).join("\n");
  }
  if (event.type === "repository.context") {
    return `\`\`\`json\n${safeJson(event.repository)}\n\`\`\``;
  }
  if (event.type === "system") {
    return fencedText(event.text);
  }
  return `\`\`\`json\n${safeJson(event)}\n\`\`\``;
}

function fencedText(text: string): string {
  return `\`\`\`text\n${text.replace(/```/g, "`\u200b``")}\n\`\`\``;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/```/g, "`\u200b``");
}

function attachSse(req: IncomingMessage, res: ServerResponse): void {
  sendCorsHeaders(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  sseClients.add(res);
  res.write(`event: ready\ndata: ${JSON.stringify({ meetingId, next: events.length })}\n\n`);
  req.on("close", () => sseClients.delete(res));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBuffer(req);
  return raw.length ? JSON.parse(raw.toString("utf8")) as T : {} as T;
}

async function readBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  sendCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendArtifactFile(pathname: string, res: ServerResponse): void {
  const artifactsRoot = resolveRepoPath("artifacts");
  const rawRelative = decodeURIComponent(pathname.slice("/artifacts/".length));
  const safeRelative = normalize(rawRelative).replace(/^(\.\.[\\/])+/, "");
  const filePath = resolve(artifactsRoot, safeRelative);
  if (filePath !== artifactsRoot && !filePath.startsWith(`${artifactsRoot}${sep}`)) {
    return sendJson(res, { error: "invalid artifact path" }, 400);
  }
  if (!existsSync(filePath)) return sendJson(res, { error: "artifact file not found" }, 404);
  sendCorsHeaders(res);
  res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-cache" });
  createReadStream(filePath).pipe(res);
}

function sendRealtimeArtifactFile(pathname: string, res: ServerResponse): void {
  const rawRelative = decodeURIComponent(pathname.slice("/realtime-artifacts/".length));
  const safeRelative = normalize(rawRelative || "index.html").replace(/^(\.\.[\\/])+/, "");
  const filePath = resolve(realtimeArtifactRoot, safeRelative);
  if (filePath !== realtimeArtifactRoot && !filePath.startsWith(`${realtimeArtifactRoot}${sep}`)) {
    return sendJson(res, { error: "invalid realtime artifact path" }, 400);
  }
  if (!existsSync(filePath)) {
    ensureRealtimeArtifact();
  }
  if (!existsSync(filePath)) return sendJson(res, { error: "realtime artifact not found" }, 404);
  sendCorsHeaders(res);
  res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-cache" });
  createReadStream(filePath).pipe(res);
}

async function createRealtimeCall(sdp: string, res: ServerResponse): Promise<void> {
  if (!sdp.trim()) return sendJson(res, { error: "missing sdp" }, 400);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return sendJson(res, { error: "OPENAI_API_KEY is not configured" }, 400);

  ensureRealtimeArtifact();

  const session = {
    type: "realtime",
    model: process.env.MEETING_REALTIME_MODEL || "gpt-realtime-2",
    instructions: buildRealtimeInstructions(),
    audio: {
      output: {
        voice: process.env.MEETING_REALTIME_VOICE || "marin"
      }
    },
    tools: [
      {
        type: "function",
        name: "read_repo_guide",
        description: "Read the curated repository guide for this project. Use this first when you need to know which scripts exist, where they are, and how to use them.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "raise_meeting_hand",
        description: "Silently raise your hand in the meeting to indicate you have a useful idea, plan, or proposal without speaking yet.",
        parameters: {
          type: "object",
          properties: {
            reason: { type: "string" },
            confidence: { type: "number" },
            requestedMode: { type: "string", enum: ["speak", "show", "work", "review"] }
          },
          required: ["reason"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "post_meeting_markdown",
        description: "Post Markdown into the meeting UI silently. Use surface=status for short summaries and surface=canvas for diagrams or richer artifacts.",
        parameters: {
          type: "object",
          properties: {
            markdown: { type: "string" },
            title: { type: "string" },
            surface: { type: "string", enum: ["status", "canvas"] },
            lifecycle: { type: "string", enum: ["draft", "final"] }
          },
          required: ["markdown"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "create_meeting_task",
        description: "Create or update a visible task card in the meeting UI for proposed work. Reuse the same taskKey when updating the lifecycle of an existing task.",
        parameters: {
          type: "object",
          properties: {
            taskKey: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["queued", "working", "blocked", "done", "failed"] },
            taskClass: { type: "string", enum: ["artifact.render", "artifact.edit", "code.change", "research.explore", "critique.review", "conversation"] },
            branch: { type: "string" },
            previewUrl: { type: "string" },
            details: { type: "string" }
          },
          required: ["title"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "read_rendered_html",
        description: "Read the current live preview HTML file at .meeting/realtime/index.html before editing it.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "write_rendered_html",
        description: "Write a complete standalone HTML document to .meeting/realtime/index.html. The browser preview reloads after this tool succeeds.",
        parameters: {
          type: "object",
          properties: {
            html: { type: "string", description: "Full HTML document contents for index.html." }
          },
          required: ["html"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "run_shell_command",
        description: "Run a short shell command inside the allowed workspace. Use this for repo inspection and lightweight tasks such as rg, ls, git status, cat, or build/test commands.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string", description: "Optional path relative to the allowed workspace root." }
          },
          required: ["command"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "run_codex_task",
        description: "Invoke the local Codex CLI to inspect, explain, or modify code in the allowed workspace. This is the main tool for multi-step coding work.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            cwd: { type: "string", description: "Optional path relative to the allowed workspace root." }
          },
          required: ["prompt"],
          additionalProperties: false
        }
      }
    ],
    tool_choice: "auto"
  };

  const form = new FormData();
  form.set("sdp", sdp);
  form.set("session", JSON.stringify(session));

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });
    const answer = await response.text();
    if (!response.ok) {
      return sendJson(res, { error: answer || `OpenAI returned ${response.status}` }, response.status);
    }
    sendCorsHeaders(res);
    res.writeHead(200, { "Content-Type": "application/sdp" });
    res.end(answer);
  } catch (error) {
    sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function runRealtimeTool(name: string, input: unknown, res: ServerResponse): Promise<void> {
  try {
    let output: unknown;
    if (name === "read_repo_guide") {
      output = {
        ok: true,
        repoRoot,
        workspaceRoot,
        guide: repoGuideText()
      };
    } else if (name === "raise_meeting_hand") {
      const args = asObject(input);
      const requestedMode = asRequestedMode(args.requestedMode);
      const confidence = typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.8;
      const reason = String(args.reason || "").trim();
      if (!reason) throw new Error("reason is required");
      appendEvent({
        id: newEventId("hand"),
        type: "agent.hand_raise",
        meetingId,
        createdAt: nowIso(),
        agentId: "realtime-codex",
        reason,
        confidence,
        requestedMode
      } as MeetingEvent);
      output = { ok: true, requestedMode, confidence, reason };
    } else if (name === "post_meeting_markdown") {
      const args = asObject(input);
      const markdown = String(args.markdown || "").trim();
      if (!markdown) throw new Error("markdown is required");
      const title = optionalString(args.title);
      const surface = asSurface(args.surface);
      const lifecycle = asLifecycle(args.lifecycle);
      appendEvent({
        id: newEventId("msg"),
        type: "agent.message",
        meetingId,
        createdAt: nowIso(),
        agentId: "realtime-codex",
        format: "markdown",
        surface,
        lifecycle,
        text: title ? `# ${title}\n\n${markdown}` : markdown
      } as MeetingEvent);
      output = { ok: true, surface, lifecycle };
    } else if (name === "create_meeting_task") {
      const args = asObject(input);
      const title = String(args.title || "").trim();
      if (!title) throw new Error("title is required");
      const status = asTaskStatus(args.status);
      const taskKey = optionalString(args.taskKey) || slugTaskKey(title);
      const taskClass = asTaskClass(args.taskClass);
      const previewUrl = optionalString(args.previewUrl);
      const details = optionalString(args.details);
      const branch = optionalString(args.branch);
      appendEvent({
        id: newEventId("task"),
        type: "agent.task",
        meetingId,
        createdAt: nowIso(),
        agentId: "realtime-codex",
        taskKey,
        title,
        status,
        taskClass,
        branch,
        previewUrl,
        details
      } as MeetingEvent);
      if (status === "done" || status === "failed") {
        appendEvent({
          id: newEventId("hand"),
          type: "agent.hand_raise",
          meetingId,
          createdAt: nowIso(),
          agentId: "realtime-codex",
          reason: status === "done"
            ? `I completed task "${title}" and can show the result${previewUrl ? ` at ${previewUrl}` : ""}.`
            : `Task "${title}" failed or is blocked and needs review.`,
          confidence: status === "done" ? 0.92 : 0.88,
          requestedMode: status === "done" ? "show" : "review"
        } as MeetingEvent);
      }
      output = { ok: true, taskKey, title, status };
    } else if (name === "read_rendered_html") {
      ensureRealtimeArtifact();
      output = {
        ok: true,
        path: realtimeArtifactPath,
        previewUrl: `http://localhost:${port}/realtime-artifacts/index.html`,
        html: readFileSync(realtimeArtifactPath, "utf8")
      };
    } else if (name === "write_rendered_html") {
      const args = asObject(input);
      const html = String(args.html || "");
      if (!html.trim()) throw new Error("html is required");
      mkdirSync(realtimeArtifactRoot, { recursive: true });
      writeFileSync(realtimeArtifactPath, html, "utf8");
      output = {
        ok: true,
        path: realtimeArtifactPath,
        previewUrl: `http://localhost:${port}/realtime-artifacts/index.html`,
        bytes: Buffer.byteLength(html, "utf8")
      };
    } else if (name === "run_shell_command") {
      const args = asObject(input);
      const command = String(args.command || "");
      if (!command.trim()) throw new Error("command is required");
      const cwd = resolveWorkspacePath(optionalString(args.cwd));
      output = await runShellCommand(command, cwd);
    } else if (name === "run_codex_task") {
      const args = asObject(input);
      const prompt = String(args.prompt || "");
      if (!prompt.trim()) throw new Error("prompt is required");
      const cwd = resolveWorkspacePath(optionalString(args.cwd));
      output = await runCodexTask(prompt, cwd);
    } else {
      throw new Error(`unknown tool: ${name}`);
    }
    sendJson(res, { ok: true, output });
  } catch (error) {
    sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

function buildRealtimeInstructions(): string {
  return [
    "You are a live coding meeting agent inside a browser-based voice call.",
    "Most of the time you are a silent background listener, not an always-speaking chatbot.",
    "Speak naturally and keep spoken answers concise when explicitly granted the floor.",
    "You have eight tools and should accurately describe them when asked.",
    "Available tools: read_repo_guide, raise_meeting_hand, post_meeting_markdown, create_meeting_task, read_rendered_html, write_rendered_html, run_shell_command, run_codex_task.",
    "When you need to understand this repository's scripts, artifact workflow, or file layout, call read_repo_guide before guessing.",
    "In background listening mode, prefer silent actions: raise_meeting_hand, post_meeting_markdown, create_meeting_task, run_shell_command, and run_codex_task.",
    "Do not speak automatically while in silent background mode unless the client explicitly grants you the floor.",
    "run_codex_task is your primary tool for interacting with local Codex and doing real coding work in the repository.",
    "run_shell_command is for quick inspection and lightweight terminal tasks.",
    "read_rendered_html and write_rendered_html are specifically for the isolated browser preview file and are not the main path for improving the app.",
    "You have tool access to inspect the local workspace, run Codex, and write a complete index.html preview that renders on screen.",
    "Before overwriting HTML, read the current HTML first unless you are creating it from scratch.",
    "When asked to build or modify the live preview, prefer writing a full standalone HTML document with inline CSS and JS unless external assets are necessary.",
    "When the user asks to improve the existing Meeting system or UI, prefer run_codex_task to edit the real app files so the dev server hot reloads the actual interface.",
    `The editable preview file is ${realtimeArtifactPath}.`,
    `The main application repository root is ${repoRoot}.`,
    `The allowed workspace root for shell and Codex work is ${workspaceRoot}.`,
    "When the user asks whether you can work with Codex, answer yes and mention run_codex_task explicitly.",
    "Use run_codex_task for larger code edits, codebase analysis, or multi-step repo work.",
    "If you change the preview, tell the user what changed and what to look at on screen."
  ].join("\n");
}

function ensureRealtimeArtifact(): void {
  if (existsSync(realtimeArtifactPath)) return;
  mkdirSync(realtimeArtifactRoot, { recursive: true });
  writeFileSync(realtimeArtifactPath, defaultRealtimeHtml(), "utf8");
}

function defaultRealtimeHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    "  <title>Realtime Agent Canvas</title>",
    "  <style>",
    "    :root { color-scheme: dark; --bg: #0d1117; --panel: #161b22; --ink: #e6edf3; --muted: #9da7b3; --accent: #2f81f7; }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; min-height: 100vh; font-family: ui-sans-serif, system-ui, sans-serif; background: radial-gradient(circle at top, #1f2937, var(--bg) 42%); color: var(--ink); display: grid; place-items: center; }",
    "    main { width: min(980px, calc(100vw - 48px)); background: color-mix(in srgb, var(--panel) 92%, transparent); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; padding: 28px; box-shadow: 0 28px 80px rgba(0,0,0,0.35); }",
    "    h1 { margin: 0 0 10px; font-size: clamp(32px, 6vw, 64px); }",
    "    p { margin: 0; color: var(--muted); line-height: 1.6; }",
    "    .pill { display: inline-flex; margin-bottom: 16px; padding: 8px 12px; border-radius: 999px; background: rgba(47,129,247,0.14); color: #9ecbff; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    '    <div class="pill">Realtime agent canvas</div>',
    "    <h1>Say what to build.</h1>",
    "    <p>The voice agent can inspect the repo, run Codex locally, and rewrite this <code>index.html</code> file live.</p>",
    "  </main>",
    "</body>",
    "</html>"
  ].join("\n");
}

function repoGuideText(): string {
  return [
    `Repository root: ${repoRoot}`,
    `Preferred working root for real app changes: ${repoRoot}`,
    `Allowed workspace root: ${workspaceRoot}`,
    "",
    "Important paths",
    "- apps/web/src/main.tsx: existing Meeting UI and main integration surface",
    "- apps/web/src/styles.css: existing Meeting UI styles",
    "- apps/api/src/server.ts: local API, Realtime bridge, and tool handlers",
    "- scripts/: project scripts",
    "- artifacts/: durable smart-down artifacts",
    "",
    "Primary strategy",
    "- If the user asks to improve the existing app or UI, prefer run_codex_task against the real repository files so Vite hot reload updates the actual interface.",
    "- Use run_shell_command for quick inspection such as rg, ls, cat, git status, pnpm build, or running a script once you know the exact command.",
    "- Use read_rendered_html/write_rendered_html only for the isolated preview file, not as the default path for app improvements.",
    "",
    "Artifact workflow",
    "- Smart artifacts live under artifacts/dt=YYYY-MM-DD/hour=HH/<kind>-<slug>/",
    "- Each artifact folder contains artifact.smart.md and manifest.json.",
    "- One folder is one evolving idea. Update in place for the same idea; do not make v2 copies unless explicitly asked.",
    "- artifacts/index.json is the generated artifact index.",
    "",
    "Key script: smart artifacts",
    "- Script path: scripts/smart-artifact.mjs",
    "- Create or update an artifact:",
    "  node scripts/smart-artifact.mjs write --kind note --slug napoleon-army-uniforms --title \"Napoleon's Army Uniforms\" --summary \"Brief summary\" --body \"# Napoleon's Army Uniforms\"",
    "- List artifacts:",
    "  node scripts/smart-artifact.mjs list",
    "- Search artifacts:",
    "  node scripts/smart-artifact.mjs find napoleon",
    "- Rebuild the index:",
    "  node scripts/smart-artifact.mjs index",
    "",
    "Behavior of smart-artifact.mjs",
    "- write creates or updates artifact.smart.md and manifest.json",
    "- write also regenerates artifacts/index.json automatically",
    "- known kinds include diagram, plan, implementation, status, note, spec, decision",
    "",
    "Useful inspection commands",
    "- rg --files scripts",
    "- rg -n \"smart-artifact|artifact\" scripts docs apps -S",
    "- sed -n '1,220p' docs/artifacts.md",
    "- sed -n '1,220p' scripts/smart-artifact.mjs",
    "",
    "Rule of thumb",
    "- Do not claim a script is unavailable until you have either read_repo_guide or inspected scripts/ with run_shell_command.",
    "- If the user asks whether you can use a script, answer based on the guide or direct inspection rather than guesswork."
  ].join("\n");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRequestedMode(value: unknown): "speak" | "show" | "work" | "review" {
  return value === "show" || value === "work" || value === "review" ? value : "speak";
}

function asSurface(value: unknown): "status" | "canvas" {
  return value === "canvas" ? "canvas" : "status";
}

function asLifecycle(value: unknown): "draft" | "final" {
  return value === "draft" ? "draft" : "final";
}

function asTaskStatus(value: unknown): "queued" | "working" | "blocked" | "done" | "failed" {
  return value === "working" || value === "blocked" || value === "done" || value === "failed" ? value : "queued";
}

function asTaskClass(value: unknown): "artifact.render" | "artifact.edit" | "code.change" | "research.explore" | "critique.review" | "conversation" | undefined {
  return value === "artifact.render"
    || value === "artifact.edit"
    || value === "code.change"
    || value === "research.explore"
    || value === "critique.review"
    || value === "conversation"
    ? value
    : undefined;
}

function slugTaskKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || newEventId("taskkey");
}

function resolveWorkspacePath(requested: string | undefined): string {
  const target = requested ? resolve(workspaceRoot, requested) : repoRoot;
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error("requested cwd is outside the allowed workspace root");
  }
  return target;
}

async function runShellCommand(command: string, cwd: string): Promise<unknown> {
  if (isDangerousCommand(command)) {
    throw new Error("command blocked by local safety policy");
  }
  return runProcess(command, { cwd, shell: true, timeoutMs: 20_000 });
}

async function runCodexTask(prompt: string, cwd: string): Promise<unknown> {
  return runProcess("codex", {
    cwd,
    args: [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--sandbox",
      "danger-full-access",
      "--cd",
      cwd,
      "--",
      prompt
    ],
    timeoutMs: 180_000
  });
}

function runProcess(command: string, options: { cwd: string; args?: string[]; shell?: boolean; timeoutMs: number }): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, options.args || [], {
      cwd: options.cwd,
      shell: options.shell || false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0,
        code,
        signal,
        cwd: options.cwd,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    });
  });
}

function trimOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 20_000 ? `${trimmed.slice(0, 20_000)}\n...truncated...` : trimmed;
}

function isDangerousCommand(command: string): boolean {
  const lowered = command.toLowerCase();
  const patterns = [
    /(^|[;&|]\s*|\s)rm(\s|$)/,
    /(^|[;&|]\s*|\s)mv(\s|$)/,
    /(^|[;&|]\s*|\s)sudo(\s|$)/,
    /(^|[;&|]\s*|\s)shutdown(\s|$)/,
    /(^|[;&|]\s*|\s)reboot(\s|$)/,
    /(^|[;&|]\s*|\s)mkfs(\s|$)/,
    /diskutil\s+erase/,
    /git\s+reset\s+--hard/,
    /git\s+checkout\s+--/,
    />:/
  ];
  return patterns.some((pattern) => pattern.test(lowered));
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".md": return "text/markdown; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function sendCors(res: ServerResponse, status: number): void {
  sendCorsHeaders(res);
  res.writeHead(status);
  res.end();
}

function sendCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function resolveRepoPath(path: string): string {
  if (path.startsWith("/")) return path;
  const cwd = process.cwd();
  if (cwd.endsWith("/apps/api")) return resolve(cwd, "../..", path);
  return resolve(cwd, path);
}

function isIgnorableTranscript(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (/^[\[(]\s*[^\])]{1,80}\s*[\])]$/.test(normalized)) return true;
  if (/^[\[(]?\s*(blank_audio|no audio|silence|music|noise|background_noise|whooshing|wind|static|keyboard clicking|typing|clicking|people chattering|chattering|background chatter|sighs?|breathing|cough|coughing|crickets chirping|crickets|chirping|bell ringing|ringing)\s*[\])]?$/i.test(normalized)) return true;

  const words = normalized.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const filler = new Set(["um", "uh", "er", "ah", "okay", "ok", "so", "this", "that", "is", "like"]);
  const fillerCount = words.filter((word) => filler.has(word)).length;
  const uniqueWords = new Set(words);
  return words.length >= 8 && (fillerCount / words.length > 0.75 || uniqueWords.size <= 4);
}

function seedSystemEvent(): void {
  appendEvent({
    id: newEventId("sys"),
    type: "system",
    meetingId,
    createdAt: nowIso(),
    level: "info",
    text: "Meeting API ready. Transcripts come from local Whisper; agent output comes through Pi or MCP."
  });
}
