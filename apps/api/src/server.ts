import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { newEventId, nowIso, type MeetingEvent } from "@meeting/protocol";
import { speechProviderStatus } from "./speech.js";
import { loadDotEnv } from "./env.js";
import { transcribeWithLocalWhisper } from "./local-whisper.js";

const port = Number(process.env.MEETING_API_PORT || 4317);
const meetingId = "local-demo";
const events: MeetingEvent[] = [];
const sseClients = new Set<ServerResponse>();

loadDotEnv();
seedSystemEvent();
startMockTranscript();

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
  if (req.method === "POST" && url.pathname === "/mock/utterance") {
    const body = await readJson<{ text?: string; speakerLabel?: string }>(req);
    const startMs = Date.now() % 3_600_000;
    appendEvent({
      id: newEventId("utt"),
      type: "utterance.final",
      meetingId,
      createdAt: nowIso(),
      speakerId: "host",
      speakerLabel: body.speakerLabel || "Host",
      text: body.text || "Let's ask Codex to sketch the repository workflow.",
      startMs,
      endMs: startMs + 2500
    });
    return sendJson(res, { ok: true, next: events.length });
  }
  if (req.method === "POST" && url.pathname === "/audio/chunk") {
    const extension = url.searchParams.get("extension") || "webm";
    const speakerLabel = url.searchParams.get("speaker") || "Host";
    const audio = await readBuffer(req);
    try {
      const result = await transcribeWithLocalWhisper(audio, extension);
      if (result.text) {
        const startMs = Date.now() % 3_600_000;
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

function appendEvent(event: MeetingEvent): void {
  events.push(event);
  const payload = `event: meeting\nid: ${events.length}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
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

function seedSystemEvent(): void {
  appendEvent({
    id: newEventId("sys"),
    type: "system",
    meetingId,
    createdAt: nowIso(),
    level: "info",
    text: process.env.DEEPGRAM_API_KEY ? "Deepgram key detected." : "Running with mock transcript events until DEEPGRAM_API_KEY is set."
  });
}

function startMockTranscript(): void {
  if (process.env.MOCK_TRANSCRIPT === "false") {
    return;
  }
  const lines = [
    "Welcome. We are designing an agentic meeting room.",
    "The agents should listen silently and raise a hand only when useful.",
    "Can Codex prepare a branch with the transcript panel prototype?",
    "We need interruption support for agent speech.",
    "Let's keep the first demo local and P2P-ready."
  ];
  let index = 0;
  setInterval(() => {
    const startMs = Date.now() % 3_600_000;
    appendEvent({
      id: newEventId("utt"),
      type: "utterance.final",
      meetingId,
      createdAt: nowIso(),
      speakerId: "mock-host",
      speakerLabel: "Mock Host",
      text: lines[index % lines.length],
      startMs,
      endMs: startMs + 2200
    });
    index += 1;
  }, 8000);
}
