#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const cwd = resolve(args.cwd || process.cwd());
const input = resolve(cwd, args.input || ".meeting/events.jsonl");
const output = resolve(cwd, args.output || ".meeting/session.md");

const raw = await readFile(input, "utf8");
const events = raw
  .split("\n")
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      return {
        id: `malformed_${index}`,
        type: "system",
        meetingId: "unknown",
        createdAt: new Date(0).toISOString(),
        level: "warn",
        text: `Malformed JSONL line ${index + 1}: ${line}`
      };
    }
  });

await mkdir(dirname(output), { recursive: true });
await writeFile(output, [sessionHeader(input), ...events.map(formatSessionEvent)].join(""));
console.log(JSON.stringify({ input, output, events: events.length }, null, 2));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    parsed[key] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) index++;
  }
  return parsed;
}

function sessionHeader(sourcePath) {
  return [
    "# Meeting Session Log",
    "",
    "Readable transcript generated from the Meeting API event stream.",
    "",
    `Raw JSONL source: \`${sourcePath}\``,
    "",
    "---",
    ""
  ].join("\n");
}

function formatSessionEvent(event) {
  const actor = eventActor(event);
  const title = `## ${event.createdAt || "unknown-time"} — ${event.type || "unknown"} — ${actor}`;
  return `${title}\n\n${eventBody(event)}\n\n---\n\n`;
}

function eventActor(event) {
  if ("agentId" in event) return event.agentId;
  if ("speakerLabel" in event) return event.speakerLabel;
  if ("level" in event) return event.level;
  return "meeting";
}

function eventBody(event) {
  if (event.type === "utterance.final" || event.type === "utterance.partial") {
    return fencedText(event.text || "");
  }
  if (event.type === "agent.message") {
    const meta = [
      event.surface ? `surface: ${event.surface}` : undefined,
      event.lifecycle ? `lifecycle: ${event.lifecycle}` : undefined,
      typeof event.streaming === "boolean" ? `streaming: ${event.streaming}` : undefined,
      event.documentId ? `documentId: ${event.documentId}` : undefined
    ].filter(Boolean).join("\n");
    return [meta ? `\`\`\`yaml\n${meta}\n\`\`\`` : "", fencedText(event.text || "")].filter(Boolean).join("\n\n");
  }
  if (event.type === "agent.trace") {
    return [
      `channel: ${event.channel || "unknown"}`,
      "",
      fencedText(event.text || ""),
      event.details === undefined ? "" : `\n<details>\n<summary>details</summary>\n\n\`\`\`json\n${safeJson(event.details)}\n\`\`\`\n\n</details>`
    ].join("\n").trim();
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
    return [`requestedMode: ${event.requestedMode}`, `confidence: ${event.confidence}`, fencedText(event.reason || "")].join("\n");
  }
  if (event.type === "agent.floor") {
    return [`granted: ${event.granted}`, `mode: ${event.mode}`, event.note ? fencedText(event.note) : undefined].filter(Boolean).join("\n");
  }
  if (event.type === "repository.context") {
    return `\`\`\`json\n${safeJson(event.repository)}\n\`\`\``;
  }
  if (event.type === "system") {
    return fencedText(event.text || "");
  }
  return `\`\`\`json\n${safeJson(event)}\n\`\`\``;
}

function fencedText(text) {
  return `\`\`\`text\n${String(text).replace(/```/g, "`\u200b``")}\n\`\`\``;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(/```/g, "`\u200b``");
}
