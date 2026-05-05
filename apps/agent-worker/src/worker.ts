import { spawn } from "node:child_process";
import { newEventId, nowIso, type MeetingEvent, type UtteranceEvent } from "@meeting/protocol";

const api = process.env.MEETING_API_URL || "http://localhost:4317";
const meetingId = "local-demo";
const agentId = process.env.MEETING_AGENT_ID || "local-codex";
const backend = process.env.MEETING_AGENT_BACKEND || "codex";
const autorun = process.env.MEETING_AGENT_AUTORUN === "true";
let cursor = 0;
const raisedFor = new Set<string>();

console.log(`[meeting-agent] ${agentId} listening at ${api} backend=${backend} autorun=${autorun}`);
setInterval(tick, 1500);
void tick();

async function tick(): Promise<void> {
  const res = await fetch(`${api}/events?since=${cursor}`).catch(() => null);
  if (!res?.ok) {
    return;
  }
  const payload = await res.json() as { events: MeetingEvent[]; next: number };
  cursor = payload.next;
  for (const event of payload.events) {
    if (event.type === "utterance.final") {
      await considerUtterance(event);
    }
    if (event.type === "agent.floor" && event.agentId === agentId && event.granted) {
      await respondToFloor(event.mode);
    }
  }
}

async function considerUtterance(event: UtteranceEvent): Promise<void> {
  const text = event.text.toLowerCase();
  const relevant = ["codex", "claude", "agent", "prototype", "branch", "repository", "ui"].some((term) => text.includes(term));
  if (!relevant || raisedFor.has(event.id)) {
    return;
  }
  raisedFor.add(event.id);
  await postEvent({
    id: newEventId("hand"),
    type: "agent.hand_raise",
    meetingId,
    createdAt: nowIso(),
    agentId,
    reason: `I heard: "${event.text}". I can inspect or prototype this if granted the floor.`,
    confidence: 0.72,
    requestedMode: text.includes("branch") || text.includes("prototype") ? "work" : "speak"
  });
}

async function respondToFloor(mode: "speak" | "show" | "work" | "review"): Promise<void> {
  if (!autorun) {
    await postEvent({
      id: newEventId("msg"),
      type: "agent.message",
      meetingId,
      createdAt: nowIso(),
      agentId,
      format: "markdown",
      text: `Floor granted for **${mode}**. Autorun is disabled, so I am only acknowledging. Set \`MEETING_AGENT_AUTORUN=true\` to let the worker invoke ${backend}.`
    });
    return;
  }
  const output = await runLocalAgent(`You are ${agentId} in an agentic meeting. The host granted floor for ${mode}. Reply with a concise plan.`);
  await postEvent({
    id: newEventId("msg"),
    type: "agent.message",
    meetingId,
    createdAt: nowIso(),
    agentId,
    format: "markdown",
    text: output || "No output from local agent."
  });
}

async function postEvent(event: MeetingEvent): Promise<void> {
  await fetch(`${api}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event)
  }).catch((error) => console.error("[meeting-agent] post failed", error));
}

function runLocalAgent(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const cmd = backend === "claude" ? "claude" : "codex";
    const args = backend === "claude" ? ["-p", prompt] : ["exec", "--", prompt];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve(`Local ${cmd} failed to start: ${error.message}`));
    child.on("close", () => resolve(stdout.trim() || stderr.trim()));
  });
}

