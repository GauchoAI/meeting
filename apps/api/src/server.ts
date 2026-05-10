import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
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
const pipelineRoot = resolveRepoPath(".meeting/pipeline");
const conversationPipelineRoot = resolve(pipelineRoot, "conversation");
const implementationPipelineRoot = resolve(pipelineRoot, "implementation");
const implementationInboxRoot = resolve(implementationPipelineRoot, "inbox");
const implementationConversationInboxPath = resolve(implementationInboxRoot, "conversation.jsonl");
const piHandoffsPath = resolve(implementationInboxRoot, "pi-handoffs.jsonl");
const implementationTaskRoot = resolve(implementationPipelineRoot, "tasks");
const implementationTaskQueuedRoot = resolve(implementationTaskRoot, "queued");
const implementationTaskWorkingRoot = resolve(implementationTaskRoot, "working");
const implementationTaskDoneRoot = resolve(implementationTaskRoot, "done");
const implementationTaskFailedRoot = resolve(implementationTaskRoot, "failed");
const repoRoot = resolveRepoPath(".");
const workspaceRoot = resolveRepoPath(process.env.MEETING_WORKSPACE_ROOT || ".");
const implementationBackend = process.env.MEETING_IMPLEMENTATION_BACKEND || "pi-agent";
const events: MeetingEvent[] = [];
const sseClients = new Set<ServerResponse>();
const realtimeAgentId = "realtime-codex";
let implementationWorkerBusy = false;

loadEventLog();
if (!events.length) seedSystemEvent();
ensurePipelineLayout();

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
          stream: "conversation",
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

if (implementationBackend === "api") {
  setInterval(() => {
    void pumpImplementationQueue();
  }, 1500);
}

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
  mirrorEventToPipeline(event);
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
      event.stream ? `stream: ${event.stream}` : undefined,
      event.surface ? `surface: ${event.surface}` : undefined,
      event.lifecycle ? `lifecycle: ${event.lifecycle}` : undefined,
      typeof event.streaming === "boolean" ? `streaming: ${event.streaming}` : undefined,
      event.documentId ? `documentId: ${event.documentId}` : undefined
    ].filter(Boolean).join("\n");
    return [meta ? `\`\`\`yaml\n${meta}\n\`\`\`` : "", fencedText(event.text)].filter(Boolean).join("\n\n");
  }
  if (event.type === "agent.trace") {
    const trace = [
      event.stream ? `stream: ${event.stream}` : undefined,
      `channel: ${event.channel}`,
      "",
      fencedText(event.text),
      event.details === undefined ? "" : `\n<details>\n<summary>details</summary>\n\n\`\`\`json\n${safeJson(event.details)}\n\`\`\`\n\n</details>`
    ].join("\n");
    return trace.trim();
  }
  if (event.type === "agent.task") {
    return [
      event.stream ? `stream: ${event.stream}` : undefined,
      `status: ${event.status}`,
      `title: ${event.title}`,
      event.taskClass ? `taskClass: ${event.taskClass}` : undefined,
      event.details ? fencedText(event.details) : undefined
    ].filter(Boolean).join("\n");
  }
  if (event.type === "agent.hand_raise") {
    return [event.stream ? `stream: ${event.stream}` : undefined, `requestedMode: ${event.requestedMode}`, `confidence: ${event.confidence}`, fencedText(event.reason)].filter(Boolean).join("\n");
  }
  if (event.type === "agent.floor") {
    return [event.stream ? `stream: ${event.stream}` : undefined, `granted: ${event.granted}`, `mode: ${event.mode}`, event.note ? fencedText(event.note) : undefined].filter(Boolean).join("\n");
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
      input: {
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "en"
        },
        turn_detection: {
          type: "server_vad",
          create_response: false,
          interrupt_response: false,
          prefix_padding_ms: 300,
          silence_duration_ms: 900
        }
      },
      output: {
        voice: process.env.MEETING_REALTIME_VOICE || "marin"
      }
    },
    tools: [
      {
        type: "function",
        name: "read_meeting_context",
        description: "Read the current meeting context directly from the live event stream, including the current main canvas document, recent transcript, active tasks, and raised hands. Use this instead of exploring the repo when you need current on-screen context.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "read_repo_guide",
        description: "Read the curated repository guide for this project. Use this first when you need to know the app layout or how to delegate implementation work to pi-agent.",
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
        description: "Post Markdown into the meeting UI silently. Use surface=status for short summaries and surface=canvas for diagrams or richer live documents. Reuse a stable documentId to keep a living document updated in place conceptually.",
        parameters: {
          type: "object",
          properties: {
            markdown: { type: "string" },
            title: { type: "string" },
            surface: { type: "string", enum: ["status", "canvas"] },
            lifecycle: { type: "string", enum: ["draft", "final"] },
            documentId: { type: "string" }
          },
          required: ["markdown"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "publish_task_result",
        description: "Publish a completed task result to the main meeting canvas as a polished review document so the host can review it. Use this when a task reaches a meaningful milestone or is done.",
        parameters: {
          type: "object",
          properties: {
            taskKey: { type: "string" },
            title: { type: "string" },
            markdown: { type: "string" },
            previewUrl: { type: "string" },
            details: { type: "string" },
            handoffNote: { type: "string" }
          },
          required: ["taskKey", "title", "markdown"],
          additionalProperties: false
        }
      },
      {
        type: "function",
        name: "create_meeting_task",
        description: "Create or update a visible task card in the meeting UI for proposed work. Use stream=conversation for planning or capture work. Use stream=implementation to show proposed pi-agent work. Use run_codex_task for the actual pi-agent execution handoff.",
        parameters: {
          type: "object",
          properties: {
            taskKey: { type: "string" },
            title: { type: "string" },
            status: { type: "string", enum: ["queued", "working", "blocked", "done", "failed"] },
            stream: { type: "string", enum: ["conversation", "implementation"] },
            taskClass: { type: "string", enum: ["artifact.render", "artifact.edit", "code.change", "research.explore", "critique.review", "conversation"] },
            branch: { type: "string" },
            previewUrl: { type: "string" },
            details: { type: "string" },
            implementationPrompt: { type: "string" },
            sourceDocumentId: { type: "string" }
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
        description: "Send a concise JSONL handoff to the running pi-agent session. Pi-agent invokes Codex and answers back into the meeting through its artifact/UI tools.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            title: { type: "string", description: "Short visible task title." },
            taskKey: { type: "string", description: "Optional stable task key for lifecycle updates." },
            taskClass: { type: "string", enum: ["artifact.render", "artifact.edit", "code.change", "research.explore", "critique.review", "conversation"] },
            hints: { type: "array", items: { type: "string" }, description: "Optional short hints from the Realtime agent for pi-agent." },
            contextJsonl: { type: "string", description: "Optional newline-delimited JSON handoff records. If omitted, the API builds records from prompt/title/hints." },
            sourceDocumentId: { type: "string", description: "Optional current canvas document id that motivated the task." },
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
    if (name === "read_meeting_context") {
      output = readMeetingContext();
    } else if (name === "read_repo_guide") {
      output = {
        ok: true,
        repoRoot,
        workspaceRoot,
        guide: repoGuideText()
      };
    } else if (isRealtimeArtifactTool(name)) {
      throw new Error("Durable artifact tools are reserved for pi-agent. Queue an implementation task with run_codex_task or create_meeting_task stream=implementation instead.");
    } else if (name === "raise_meeting_hand") {
      const args = asObject(input);
      const requestedMode = asRequestedMode(args.requestedMode);
      const confidence = typeof args.confidence === "number" ? Math.max(0, Math.min(1, args.confidence)) : 0.8;
      const reason = String(args.reason || "").trim();
      if (!reason) throw new Error("reason is required");
      appendEvent({
        id: newEventId("hand"),
        type: "agent.hand_raise",
        stream: "conversation",
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
      const documentId = optionalString(args.documentId) || (surface === "canvas" ? "realtime-live-canvas" : undefined);
      appendEvent({
        id: newEventId("msg"),
        type: "agent.message",
        stream: "conversation",
        meetingId,
        createdAt: nowIso(),
        agentId: "realtime-codex",
        format: "markdown",
        surface,
        lifecycle,
        documentId,
        text: title ? `# ${title}\n\n${markdown}` : markdown
      } as MeetingEvent);
      output = { ok: true, surface, lifecycle, documentId };
    } else if (name === "publish_task_result") {
      const args = asObject(input);
      const taskKey = String(args.taskKey || "").trim();
      const title = String(args.title || "").trim();
      const markdown = String(args.markdown || "").trim();
      if (!taskKey) throw new Error("taskKey is required");
      if (!title) throw new Error("title is required");
      if (!markdown) throw new Error("markdown is required");
      const previewUrl = optionalString(args.previewUrl);
      const details = optionalString(args.details);
      const handoffNote = optionalString(args.handoffNote);
      appendEvent({
        id: newEventId("msg"),
        type: "agent.message",
        stream: "implementation",
        meetingId,
        createdAt: nowIso(),
        agentId: "realtime-codex",
        format: "markdown",
        surface: "canvas",
        lifecycle: "final",
        documentId: `task-result:${taskKey}`,
        text: `# ${title}\n\n${markdown}${previewUrl ? `\n\n[Open preview](${previewUrl})` : ""}${details ? `\n\n## Delivery notes\n\n${details}` : ""}`
      } as MeetingEvent);
      appendEvent({
        id: newEventId("hand"),
        type: "agent.hand_raise",
        stream: "implementation",
        meetingId,
        createdAt: nowIso(),
        agentId: "realtime-codex",
        reason: handoffNote || `I published the latest result for "${title}" on the main canvas and can walk through it.`,
        confidence: 0.95,
        requestedMode: "show"
      } as MeetingEvent);
      output = { ok: true, taskKey, documentId: `task-result:${taskKey}` };
    } else if (name === "create_meeting_task") {
      const args = asObject(input);
      const title = String(args.title || "").trim();
      if (!title) throw new Error("title is required");
      const status = asTaskStatus(args.status);
      const stream = asMeetingStream(args.stream) || "conversation";
      const taskKey = optionalString(args.taskKey) || slugTaskKey(title);
      const taskClass = asTaskClass(args.taskClass);
      const previewUrl = optionalString(args.previewUrl);
      const details = optionalString(args.details);
      const branch = optionalString(args.branch);
      const implementationPrompt = optionalString(args.implementationPrompt);
      const sourceDocumentId = optionalString(args.sourceDocumentId);
      appendEvent({
        id: newEventId("task"),
        type: "agent.task",
        stream,
        meetingId,
        createdAt: nowIso(),
        agentId: realtimeAgentId,
        taskKey,
        title,
        status,
        taskClass,
        branch,
        previewUrl,
        details,
        implementationPrompt,
        sourceDocumentId
      } as MeetingEvent);
      if (status === "done" || status === "failed") {
        appendEvent({
          id: newEventId("hand"),
          type: "agent.hand_raise",
          stream,
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
      const requestedCwd = optionalString(args.cwd);
      const cwd = requestedCwd ? resolveWorkspacePath(requestedCwd) : repoRoot;
      const title = optionalString(args.title) || implementationTitleFromPrompt(prompt);
      const taskKey = optionalString(args.taskKey) || slugTaskKey(title);
      const taskClass = asTaskClass(args.taskClass) || "artifact.render";
      const sourceDocumentId = optionalString(args.sourceDocumentId);
      const hints = optionalStringArray(args.hints);
      const contextJsonl = optionalString(args.contextJsonl);
      const handoffJsonl = contextJsonl || buildPiHandoffJsonl({ taskKey, title, prompt, hints, cwd, sourceDocumentId, taskClass });
      appendPiHandoff(handoffJsonl);
      appendEvent({
        id: newEventId("utt"),
        type: "utterance.final",
        stream: "implementation",
        meetingId,
        createdAt: nowIso(),
        speakerId: "realtime-handoff",
        speakerLabel: "Realtime handoff",
        text: [
          "Realtime agent handoff to pi-agent. Treat the JSONL below as the task handoff, not as a raw transcript dump.",
          "Use the Meeting artifact tools to answer in the Meeting UI. If a durable artifact is requested, create/update it and show it.",
          "",
          handoffJsonl
        ].join("\n"),
        startMs: Date.now() % 3_600_000,
        endMs: (Date.now() % 3_600_000) + 1,
        taskClass
      } as MeetingEvent);
      output = { ok: true, delegatedTo: "pi-agent", taskKey, title, taskClass, handoffPath: piHandoffsPath };
    } else {
      throw new Error(`unknown tool: ${name}`);
    }
    sendJson(res, { ok: true, output });
  } catch (error) {
    sendJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

function buildRealtimeInstructions(): string {
  const startupContext = summarizeStartupContext();
  return [
    "You are a live coding meeting agent inside a browser-based voice call.",
    "Most of the time you are a silent background listener, not an always-speaking chatbot.",
    "Speak naturally and keep spoken answers concise when explicitly granted the floor.",
    "Default to brief answers. Prefer one short sentence. Do not ramble.",
    "The current meeting canvas and transcript are first-class context, not something to rediscover.",
    "There are two streams in this system: conversation and implementation.",
    "Conversation is the true branch for human discussion, live notes, diagrams, planning, and hand raises.",
    "Implementation is the Codex execution branch with task lifecycle and result review.",
    "You have ten tools and should accurately describe them when asked.",
    "Available tools: read_meeting_context, read_repo_guide, raise_meeting_hand, post_meeting_markdown, publish_task_result, create_meeting_task, read_rendered_html, write_rendered_html, run_shell_command, run_codex_task.",
    "When you need to know what is currently on screen, what the current plan says, or what the humans are discussing, call read_meeting_context first instead of exploring the repo.",
    "When you need to understand this repository's file layout or implementation delegation path, call read_repo_guide before guessing.",
    "Durable smart artifacts belong to pi-agent, not the Realtime conversation agent.",
    "If durable artifact work is needed, create a visible implementation task if helpful, then call run_codex_task with your concise handoff for pi-agent.",
    "Do not use shell commands to run smart-artifact scripts yourself.",
    "In background listening mode, prefer silent actions: post_meeting_markdown, create_meeting_task, publish_task_result, raise_meeting_hand, run_shell_command, and run_codex_task.",
    "When you create a planning or capture task, use create_meeting_task with stream=conversation.",
    "When you start or update proposed Codex execution work, use create_meeting_task with stream=implementation for visibility, then run_codex_task for execution.",
    "run_codex_task sends your concise JSONL handoff to the running pi-agent session; it does not run Codex inline inside your conversation turn.",
    "Prefer creating implementation tasks first; use run_codex_task only when you have a clear summary, task title, and hints for pi-agent.",
    "Do not speak automatically while in silent background mode unless the client explicitly grants you the floor.",
    "Do not say you need to go look up the current project plan if a current canvas document already exists. Read meeting context and work from that.",
    "pi-agent is the implementation brain that invokes local Codex and preserves hot reload/self-improvement behavior.",
    "run_codex_task is your primary tool for delegating real coding work in the repository to pi-agent.",
    "Do not pass raw transcript dumps to run_codex_task. Pass a concise summary and short hints; raw user and agent communications are mirrored separately as JSONL.",
    "Human-granted Realtime conversation uses audio. Codex/pi-agent results use text in the UI.",
    "pi-agent answers appear back in the meeting as piAgent messages and hand raises. When pi-agent has a useful result, raise your hand with requestedMode=show or requestedMode=review, not requestedMode=speak.",
    "run_shell_command is for quick inspection and lightweight terminal tasks.",
    "Maintain a stable living canvas document with post_meeting_markdown using documentId=realtime-live-canvas.",
    "For completed or milestone work, use publish_task_result to put a polished result on the main canvas before or while raising your hand.",
    "read_rendered_html and write_rendered_html are specifically for the isolated browser preview file and are not the main path for improving the app.",
    "You have tool access to inspect the local workspace, queue Codex work through pi-agent, and write a complete index.html preview that renders on screen.",
    "Before overwriting HTML, read the current HTML first unless you are creating it from scratch.",
    "When asked to build or modify the live preview, prefer writing a full standalone HTML document with inline CSS and JS unless external assets are necessary.",
    "When the user asks to improve the existing Meeting system or UI, prefer run_codex_task so pi-agent edits the real app files and the dev server hot reloads the actual interface.",
    `The editable preview file is ${realtimeArtifactPath}.`,
    `The main application repository root is ${repoRoot}.`,
    `The allowed workspace root for shell and Codex work is ${workspaceRoot}.`,
    "When the user asks whether you can work with Codex, answer yes and mention that run_codex_task queues work through pi-agent.",
    "Use run_codex_task for larger code edits, durable artifact generation, codebase analysis, or multi-step repo work that should enter the pi-agent lifecycle.",
    "Startup context snapshot follows. Treat it as already-known context and only refresh it with read_meeting_context when needed.",
    startupContext,
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
    "    <p>The voice agent can inspect the repo, queue pi-agent implementation work, and rewrite this <code>index.html</code> file live.</p>",
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
    "- artifacts/: durable pi-agent-owned smart artifacts",
    "",
    "Primary strategy",
    "- If the user asks to improve the existing app or UI, prefer run_codex_task so pi-agent works against the real repository files and Vite hot reload updates the actual interface.",
    "- Use run_shell_command for quick inspection such as rg, ls, cat, git status, pnpm build, or running a script once you know the exact command.",
    "- Do not use run_shell_command to create, list, or edit smart artifacts; durable artifact responsibility belongs to pi-agent.",
    "- Use read_rendered_html/write_rendered_html only for the isolated preview file, not as the default path for app improvements.",
    "",
    "Artifact workflow",
    "- Durable smart artifacts are created, read, and updated by pi-agent/Codex, not by the Realtime agent.",
    "- If the meeting needs a durable artifact, create an implementation task for visibility if helpful, then call run_codex_task with a precise handoff for pi-agent.",
    "- Human Realtime conversation can be spoken audio; Codex/pi-agent results should be shown as UI text or canvas artifacts.",
    "- Realtime should keep only the current living notes/diagram on the meeting canvas with post_meeting_markdown.",
    "",
    "Useful inspection commands",
    "- rg --files scripts",
    "- rg -n \"realtime|agent-worker|pipeline|implementation\" apps packages scripts -S",
    "- sed -n '1,220p' apps/agent-worker/src/worker.ts",
    "",
    "Rule of thumb",
    "- Do not claim a script is unavailable until you have either read_repo_guide or inspected scripts/ with run_shell_command.",
    "- If the user asks whether you can use a script, answer based on the guide or direct inspection rather than guesswork."
  ].join("\n");
}

function readMeetingContext(): unknown {
  const canvasMessages = events.filter((event): event is Extract<MeetingEvent, { type: "agent.message" }> => event.type === "agent.message" && event.surface === "canvas");
  const liveCanvas = canvasMessages.find((event) => event.documentId === "realtime-live-canvas") || canvasMessages[canvasMessages.length - 1];
  const transcript = events
    .filter((event): event is Extract<MeetingEvent, { type: "utterance.final" | "utterance.partial" }> => event.type === "utterance.final" || event.type === "utterance.partial")
    .slice(-14)
    .map((event) => ({ type: event.type, speakerLabel: event.speakerLabel, text: event.text }));
  const tasks = dedupeTaskEvents(events.filter((event): event is Extract<MeetingEvent, { type: "agent.task" }> => event.type === "agent.task" && event.agentId === "realtime-codex"))
    .slice(0, 12)
    .map((event) => ({
      taskKey: event.taskKey,
      title: event.title,
      status: event.status,
      taskClass: event.taskClass,
      details: event.details,
      previewUrl: event.previewUrl
    }));
  const raisedHands = events
    .filter((event): event is Extract<MeetingEvent, { type: "agent.hand_raise" }> => event.type === "agent.hand_raise" && event.agentId === "realtime-codex")
    .slice(-8)
    .map((event) => ({ reason: event.reason, confidence: event.confidence, requestedMode: event.requestedMode }));
  const piAgentMessages = events
    .filter((event): event is Extract<MeetingEvent, { type: "agent.message" }> => event.type === "agent.message" && event.agentId === "pi-agent")
    .slice(-8)
    .map((event) => ({
      stream: event.stream,
      surface: event.surface,
      lifecycle: event.lifecycle,
      documentId: event.documentId,
      createdAt: event.createdAt,
      text: event.text
    }));
  const piAgentHands = events
    .filter((event): event is Extract<MeetingEvent, { type: "agent.hand_raise" }> => event.type === "agent.hand_raise" && event.agentId === "pi-agent")
    .slice(-6)
    .map((event) => ({ createdAt: event.createdAt, reason: event.reason, confidence: event.confidence, requestedMode: event.requestedMode }));
  return {
    ok: true,
    guidance: [
      "Treat currentCanvas as the source-of-truth project context already visible to the user.",
      "If currentCanvas exists, do not claim you need to go look for the plan elsewhere before discussing it.",
      "Durable artifacts belong to pi-agent. Use the live canvas for the current evolving conversation document and queue implementation tasks for durable artifact work."
    ],
    currentCanvas: liveCanvas ? {
      documentId: liveCanvas.documentId,
      createdAt: liveCanvas.createdAt,
      text: liveCanvas.text
    } : null,
    canvasDocuments: dedupeCanvasDocuments(canvasMessages).slice(0, 12),
    tasks,
    implementationQueue: readImplementationQueueState(),
    piAgent: {
      messages: piAgentMessages,
      raisedHands: piAgentHands
    },
    raisedHands,
    transcript
  };
}

function dedupeCanvasDocuments(messages: Array<Extract<MeetingEvent, { type: "agent.message" }>>): Array<{ documentId?: string; createdAt: string; title: string; excerpt: string }> {
  const latestByKey = new Map<string, Extract<MeetingEvent, { type: "agent.message" }>>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const event = messages[index];
    const key = event.documentId || event.id;
    if (!latestByKey.has(key)) latestByKey.set(key, event);
  }
  return [...latestByKey.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((event) => ({
      documentId: event.documentId,
      createdAt: event.createdAt,
      title: firstMarkdownHeading(event.text) || event.documentId || event.agentId,
      excerpt: event.text.trim().replace(/\s+/g, " ").slice(0, 280)
    }));
}

function dedupeTaskEvents(taskEvents: Array<Extract<MeetingEvent, { type: "agent.task" }>>): Array<Extract<MeetingEvent, { type: "agent.task" }>> {
  const latestByKey = new Map<string, Extract<MeetingEvent, { type: "agent.task" }>>();
  for (let index = taskEvents.length - 1; index >= 0; index -= 1) {
    const event = taskEvents[index];
    const key = event.taskKey || `${event.title}::${event.taskClass || ""}`;
    if (!latestByKey.has(key)) latestByKey.set(key, event);
  }
  return [...latestByKey.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function readArtifact(artifactPath: string): unknown {
  const safePath = normalize(artifactPath).replace(/^(\.\.[\\/])+/, "");
  const filePath = resolve(repoRoot, safePath);
  const artifactsRoot = resolveRepoPath("artifacts");
  if (filePath !== artifactsRoot && !filePath.startsWith(`${artifactsRoot}${sep}`)) {
    throw new Error("artifact path is outside artifacts root");
  }
  if (!existsSync(filePath)) throw new Error("artifact file not found");
  const manifestPath = resolve(dirname(filePath), "manifest.json");
  return {
    ok: true,
    path: safePath,
    markdown: readFileSync(filePath, "utf8"),
    manifest: existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null
  };
}

async function createSmartArtifact(input: { kind: string; slug: string; title?: string; summary?: string; body: string; tags?: string }): Promise<unknown> {
  const args = ["scripts/smart-artifact.mjs", "write", "--kind", input.kind, "--slug", input.slug, "--body", input.body];
  if (input.title) args.push("--title", input.title);
  if (input.summary) args.push("--summary", input.summary);
  if (input.tags) args.push("--tags", input.tags);
  const result = await runProcess("node", { cwd: repoRoot, args, timeoutMs: 20_000 });
  const path = String((result as { stdout?: string }).stdout || "").trim().split("\n").pop() || "";
  return {
    ok: true,
    path,
    artifact: path ? readArtifact(path) : null,
    result
  };
}

function firstMarkdownHeading(text: string): string | undefined {
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function summarizeStartupContext(): string {
  const context = readMeetingContext() as {
    currentCanvas?: { text?: string; documentId?: string } | null;
    tasks?: Array<{ title?: string; status?: string; taskClass?: string }>;
    implementationQueue?: { queued?: string[]; working?: string[] };
  };
  const lines = ["Current known state:"];
  const canvas = context.currentCanvas;
  if (canvas?.text) {
    lines.push(`- Current canvas document: ${canvas.documentId || "realtime-live-canvas"}`);
    lines.push(`- Canvas heading: ${firstMarkdownHeading(canvas.text) || "Untitled"}`);
    lines.push(`- Canvas excerpt: ${canvas.text.replace(/\s+/g, " ").slice(0, 320)}`);
  } else {
    lines.push("- No current canvas document is available yet.");
  }
  const tasks = Array.isArray(context.tasks) ? context.tasks.slice(0, 4) : [];
  if (tasks.length) {
    lines.push(`- Recent tasks: ${tasks.map((task) => `${task.title} [${task.status}${task.taskClass ? `/${task.taskClass}` : ""}]`).join("; ")}`);
  }
  const queued = context.implementationQueue?.queued || [];
  const working = context.implementationQueue?.working || [];
  lines.push(`- Implementation queue: queued=${queued.length}, working=${working.length}`);
  return lines.join("\n");
}

function ensurePipelineLayout(): void {
  for (const dir of [
    conversationPipelineRoot,
    implementationPipelineRoot,
    resolve(conversationPipelineRoot, "notes"),
    resolve(conversationPipelineRoot, "transcript"),
    resolve(conversationPipelineRoot, "hands"),
    implementationInboxRoot,
    implementationTaskQueuedRoot,
    implementationTaskWorkingRoot,
    implementationTaskDoneRoot,
    implementationTaskFailedRoot,
    resolve(implementationPipelineRoot, "results")
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function mirrorEventToPipeline(event: MeetingEvent): void {
  ensurePipelineLayout();
  const stream = "stream" in event && event.stream ? event.stream : inferEventStream(event);
  if (event.type === "utterance.final" || event.type === "utterance.partial") {
    if (stream === "implementation") {
      appendFileSync(resolve(implementationPipelineRoot, "events.jsonl"), `${JSON.stringify(event)}\n`);
      return;
    }
    const transcriptLog = resolve(conversationPipelineRoot, "transcript", "conversation.jsonl");
    appendFileSync(transcriptLog, `${JSON.stringify(event)}\n`);
    if (event.type === "utterance.final") {
      appendFileSync(resolve(conversationPipelineRoot, "transcript", "conversation.md"), `- ${event.speakerLabel}: ${event.text}\n`);
      appendConversationInboxRecord(event);
    }
    return;
  }
  if (event.type === "agent.message" && stream === "conversation") {
    appendFileSync(resolve(conversationPipelineRoot, "events.jsonl"), `${JSON.stringify(event)}\n`);
    appendConversationInboxRecord(event);
    if (event.surface === "canvas") {
      const documentId = event.documentId || "live-canvas";
      const notePath = resolve(conversationPipelineRoot, "notes", `${safeFileComponent(documentId)}.md`);
      writeFileSync(notePath, event.text.endsWith("\n") ? event.text : `${event.text}\n`, "utf8");
      if (documentId === "realtime-live-canvas") {
        writeFileSync(resolve(conversationPipelineRoot, "notes", "current.md"), event.text.endsWith("\n") ? event.text : `${event.text}\n`, "utf8");
      }
    }
    return;
  }
  if (event.type === "agent.hand_raise" && stream === "conversation") {
    appendFileSync(resolve(conversationPipelineRoot, "hands", "raised.jsonl"), `${JSON.stringify(event)}\n`);
    appendConversationInboxRecord(event);
    return;
  }
  if (event.type === "agent.task") {
    syncTaskEventToSpool(event as MeetingEvent & { taskKey?: string; title: string; status: string; stream?: string });
    if ((event.stream || "conversation") === "conversation") appendConversationInboxRecord(event);
    return;
  }
  if ((event.type === "agent.message" || event.type === "agent.trace" || event.type === "agent.hand_raise") && stream === "implementation") {
    appendFileSync(resolve(implementationPipelineRoot, "events.jsonl"), `${JSON.stringify(event)}\n`);
  }
}

function appendConversationInboxRecord(event: MeetingEvent): void {
  const record = conversationInboxRecord(event);
  if (!record) return;
  mkdirSync(dirname(implementationConversationInboxPath), { recursive: true });
  appendFileSync(implementationConversationInboxPath, `${JSON.stringify(record)}\n`, "utf8");
}

function conversationInboxRecord(event: MeetingEvent): Record<string, unknown> | undefined {
  if (event.type === "utterance.final") {
    return {
      ts: nowIso(),
      eventId: event.id,
      sourceCreatedAt: event.createdAt,
      role: "user",
      kind: "raw_user_comm",
      speaker: event.speakerLabel,
      text: event.text
    };
  }
  if (event.type === "agent.message") {
    return {
      ts: nowIso(),
      eventId: event.id,
      sourceCreatedAt: event.createdAt,
      role: event.agentId === "pi-agent" ? "pi-agent" : "realtime-agent",
      kind: "raw_agent_comm",
      stream: event.stream,
      surface: event.surface,
      documentId: event.documentId,
      text: event.text
    };
  }
  if (event.type === "agent.task") {
    return {
      ts: nowIso(),
      eventId: event.id,
      sourceCreatedAt: event.createdAt,
      role: "realtime-agent",
      kind: "hint",
      taskKey: event.taskKey,
      status: event.status,
      taskClass: event.taskClass,
      title: event.title,
      text: event.details || event.title
    };
  }
  if (event.type === "agent.hand_raise") {
    return {
      ts: nowIso(),
      eventId: event.id,
      sourceCreatedAt: event.createdAt,
      role: event.agentId === "pi-agent" ? "pi-agent" : "realtime-agent",
      kind: "hint",
      requestedMode: event.requestedMode,
      confidence: event.confidence,
      text: event.reason
    };
  }
  return undefined;
}

function syncTaskEventToSpool(event: MeetingEvent & { taskKey?: string; title: string; status: string; stream?: string }): void {
  if ((event.stream || "conversation") !== "implementation") {
    appendFileSync(resolve(conversationPipelineRoot, "tasks.jsonl"), `${JSON.stringify(event)}\n`);
    return;
  }
  const taskKey = event.taskKey || slugTaskKey(event.title);
  const stateDir = implementationStateDir(event.status);
  const targetDir = resolve(stateDir, taskKey);
  const currentDir = findImplementationTaskDir(taskKey);
  if (currentDir && currentDir !== targetDir) {
    mkdirSync(dirname(targetDir), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    renameSync(currentDir, targetDir);
  } else {
    mkdirSync(targetDir, { recursive: true });
  }
  const taskPath = resolve(targetDir, "task.json");
  const nextTask = {
    taskKey,
    mirroredFromEventId: event.id,
    mirroredAt: nowIso(),
    ...readJsonFile(taskPath),
    ...event
  };
  writeFileSync(taskPath, `${JSON.stringify(nextTask, null, 2)}\n`, "utf8");
  const details = (event as { details?: string }).details;
  if (typeof details === "string" && details.trim()) {
    writeFileSync(resolve(targetDir, "input.md"), details.endsWith("\n") ? details : `${details}\n`, "utf8");
  }
}

function implementationStateDir(status: string): string {
  switch (status) {
    case "working": return implementationTaskWorkingRoot;
    case "done": return implementationTaskDoneRoot;
    case "failed":
    case "blocked": return implementationTaskFailedRoot;
    case "queued":
    default: return implementationTaskQueuedRoot;
  }
}

function findImplementationTaskDir(taskKey: string): string | undefined {
  for (const root of [implementationTaskQueuedRoot, implementationTaskWorkingRoot, implementationTaskDoneRoot, implementationTaskFailedRoot]) {
    const candidate = resolve(root, taskKey);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function pumpImplementationQueue(): Promise<void> {
  if (implementationWorkerBusy) return;
  implementationWorkerBusy = true;
  try {
    const candidates = readdirSync(implementationTaskQueuedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const nextKey = candidates[0];
    if (!nextKey) return;
    const queuedDir = resolve(implementationTaskQueuedRoot, nextKey);
    const workingDir = resolve(implementationTaskWorkingRoot, nextKey);
    rmSync(workingDir, { recursive: true, force: true });
    renameSync(queuedDir, workingDir);
    const task = readJsonFile(resolve(workingDir, "task.json")) as Record<string, unknown>;
    await processImplementationTask(nextKey, workingDir, task);
  } finally {
    implementationWorkerBusy = false;
  }
}

async function processImplementationTask(taskKey: string, workingDir: string, task: Record<string, unknown>): Promise<void> {
  const title = String(task.title || taskKey);
  const details = typeof task.details === "string" ? task.details : "";
  const prompt = typeof task.implementationPrompt === "string" && task.implementationPrompt.trim()
    ? task.implementationPrompt
    : buildImplementationPrompt(title, details, task);
  appendEvent({
    id: newEventId("task"),
    type: "agent.task",
    stream: "implementation",
    meetingId,
    createdAt: nowIso(),
    agentId: "pi-agent",
    taskKey,
    title,
    status: "working",
    taskClass: asTaskClass(task.taskClass),
    details
  } as MeetingEvent);
  writeFileSync(resolve(workingDir, "worker.json"), `${JSON.stringify({ startedAt: nowIso(), prompt }, null, 2)}\n`, "utf8");
  const result = await runCodexTask(prompt, repoRoot) as { ok?: boolean; stdout?: string; stderr?: string; code?: number | null };
  const summary = summarizeImplementationResult(result);
  writeFileSync(resolve(workingDir, "result.md"), summary.endsWith("\n") ? summary : `${summary}\n`, "utf8");
  const artifact = await createSmartArtifact({
    kind: "implementation",
    slug: taskKey,
    title,
    summary: `Implementation worker output for ${title}`,
    body: summary,
    tags: "meeting,implementation,codex"
  }) as { path?: string };
  const status = result.ok ? "done" : "failed";
  const finalDir = resolve(implementationStateDir(status), taskKey);
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(workingDir, finalDir);
  const finalTask = {
    ...task,
    taskKey,
    status,
    resultSummary: summary,
    artifactPath: artifact.path,
    completedAt: nowIso()
  };
  writeFileSync(resolve(finalDir, "task.json"), `${JSON.stringify(finalTask, null, 2)}\n`, "utf8");
  appendEvent({
    id: newEventId("task"),
    type: "agent.task",
    stream: "implementation",
    meetingId,
    createdAt: nowIso(),
    agentId: "pi-agent",
    taskKey,
    title,
    status,
    taskClass: asTaskClass(task.taskClass),
    details: details || summary,
    previewUrl: artifact.path
  } as MeetingEvent);
  if (result.ok) {
    appendEvent({
      id: newEventId("msg"),
      type: "agent.message",
      stream: "implementation",
      meetingId,
      createdAt: nowIso(),
      agentId: "pi-agent",
      format: "markdown",
      surface: "status",
      lifecycle: "final",
      text: `Implementation task completed: **${title}**${artifact.path ? `\n\nArtifact: \`${artifact.path}\`` : ""}`
    } as MeetingEvent);
    appendEvent({
      id: newEventId("msg"),
      type: "agent.message",
      stream: "implementation",
      meetingId,
      createdAt: nowIso(),
      agentId: "pi-agent",
      format: "markdown",
      surface: "canvas",
      lifecycle: "final",
      documentId: `task-result:${taskKey}`,
      text: `# ${title}\n\n${summary}${artifact.path ? `\n\nArtifact path: \`${artifact.path}\`` : ""}`
    } as MeetingEvent);
    appendEvent({
      id: newEventId("hand"),
      type: "agent.hand_raise",
      stream: "conversation",
      meetingId,
      createdAt: nowIso(),
      agentId: realtimeAgentId,
      reason: `Implementation worker completed "${title}" and there is a result ready to show on screen.`,
      confidence: 0.94,
      requestedMode: "show"
    } as MeetingEvent);
  }
}

function buildImplementationPrompt(title: string, details: string, task: Record<string, unknown>): string {
  const sourceDocumentId = typeof task.sourceDocumentId === "string" ? task.sourceDocumentId : "";
  return [
    `Implementation task: ${title}`,
    details ? `Details:\n${details}` : "",
    sourceDocumentId ? `Source document: ${sourceDocumentId}` : "",
    "Work in the current repository.",
    "Make the appropriate code or content changes.",
    "Return a concise summary of what changed, verification performed, and any remaining limitations."
  ].filter(Boolean).join("\n\n");
}

function summarizeImplementationResult(result: { ok?: boolean; stdout?: string; stderr?: string; code?: number | null }): string {
  return [
    `## Outcome`,
    result.ok ? "Completed successfully." : `Failed with code ${result.code ?? "unknown"}.`,
    "",
    result.stdout ? `## Codex summary\n\n${result.stdout}` : "",
    result.stderr ? `## Stderr\n\n\`\`\`text\n${result.stderr}\n\`\`\`` : ""
  ].filter(Boolean).join("\n");
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function inferEventStream(event: MeetingEvent): "conversation" | "implementation" {
  if ("stream" in event && (event.stream === "conversation" || event.stream === "implementation")) return event.stream;
  if (event.type === "agent.task") return "conversation";
  if (event.type === "agent.message" && event.documentId?.startsWith("task-result:")) return "implementation";
  return "conversation";
}

function safeFileComponent(value: string): string {
  return value.replace(/[\\/:\s]+/g, "-").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "document";
}

function readImplementationQueueState(): Record<string, unknown> {
  return {
    queued: listTaskDirs(implementationTaskQueuedRoot),
    working: listTaskDirs(implementationTaskWorkingRoot),
    done: listTaskDirs(implementationTaskDoneRoot).slice(0, 10),
    failed: listTaskDirs(implementationTaskFailedRoot).slice(0, 10)
  };
}

function listTaskDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isRealtimeArtifactTool(name: string): boolean {
  return name === "list_artifacts" || name === "read_artifact" || name === "create_smart_artifact";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function buildPiHandoffJsonl(input: { taskKey: string; title: string; prompt: string; hints: string[]; cwd: string; sourceDocumentId?: string; taskClass: string }): string {
  const records = [
    {
      role: "realtime-agent",
      kind: "handoff_summary",
      taskKey: input.taskKey,
      taskClass: input.taskClass,
      title: input.title,
      text: input.prompt.trim(),
      cwd: input.cwd,
      sourceDocumentId: input.sourceDocumentId
    },
    ...input.hints.map((hint) => ({
      role: "realtime-agent",
      kind: "hint",
      taskKey: input.taskKey,
      text: hint
    }))
  ];
  return records.map((record) => JSON.stringify({ ts: nowIso(), ...record })).join("\n");
}

function appendPiHandoff(jsonl: string): void {
  mkdirSync(dirname(piHandoffsPath), { recursive: true });
  appendFileSync(piHandoffsPath, `${jsonl.trim()}\n`, "utf8");
}

function implementationTitleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n").map((line) => line.trim()).find(Boolean) || "Codex implementation task";
  return firstLine.replace(/^#+\s*/, "").slice(0, 90) || "Codex implementation task";
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

function asMeetingStream(value: unknown): "conversation" | "implementation" | undefined {
  return value === "conversation" || value === "implementation" ? value : undefined;
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
    text: "Meeting API ready. Transcripts come from local Whisper or Realtime; implementation work is delegated through the pi-agent or MCP."
  });
}
