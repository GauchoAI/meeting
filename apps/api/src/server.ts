import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { newEventId, nowIso, type MeetingEvent } from "@meeting/protocol";
import { speechProviderStatus } from "./speech.js";
import { loadDotEnv, loadLocalConfig } from "./env.js";
import { transcribeWithLocalWhisper } from "./local-whisper.js";

loadLocalConfig();
loadDotEnv();

const port = Number(process.env.MEETING_API_PORT || 4317);
const meetingId = process.env.MEETING_ID || "local-demo";
const eventLogPath = resolveRepoPath(process.env.MEETING_EVENT_LOG || ".meeting/events.jsonl");
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
  if (req.method === "POST" && url.pathname === "/events") {
    const event = await readJson<MeetingEvent>(req);
    appendEvent(event);
    return sendJson(res, { ok: true, next: events.length });
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
