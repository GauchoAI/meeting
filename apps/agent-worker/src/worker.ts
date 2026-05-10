import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { newEventId, nowIso, type AgentTaskEvent, type MeetingEvent } from "@meeting/protocol";

const api = process.env.MEETING_API_URL || "http://localhost:4317";
const root = resolveRepoRoot();
const artifactsIndexPath = resolve(root, "artifacts/index.json");
const meetingId = process.env.MEETING_ID || "local-demo";
const agentId = process.env.MEETING_AGENT_ID || "pi-agent";
const backend = process.env.MEETING_AGENT_BACKEND || "codex";
const autorun = process.env.MEETING_AGENT_AUTORUN !== "false";
const pipelineRoot = resolve(root, ".meeting/pipeline");
const conversationRoot = resolve(pipelineRoot, "conversation");
const conversationTranscriptJsonlPath = resolve(conversationRoot, "transcript/conversation.jsonl");
const conversationTranscriptMdPath = resolve(conversationRoot, "transcript/conversation.md");
const conversationEventsPath = resolve(conversationRoot, "events.jsonl");
const conversationTasksPath = resolve(conversationRoot, "tasks.jsonl");
const conversationHandsPath = resolve(conversationRoot, "hands/raised.jsonl");
const conversationCurrentNotePath = resolve(conversationRoot, "notes/current.md");
const implementationInboxRoot = resolve(pipelineRoot, "implementation/inbox");
const implementationConversationInboxPath = resolve(implementationInboxRoot, "conversation.jsonl");
const piHandoffsPath = resolve(implementationInboxRoot, "pi-handoffs.jsonl");
const piDirectMessagesPath = resolve(implementationInboxRoot, "pi-direct-messages.jsonl");
const implementationTaskQueuedRoot = resolve(pipelineRoot, "implementation/tasks/queued");
const implementationTaskWorkingRoot = resolve(pipelineRoot, "implementation/tasks/working");
const implementationTaskDoneRoot = resolve(pipelineRoot, "implementation/tasks/done");
const implementationTaskFailedRoot = resolve(pipelineRoot, "implementation/tasks/failed");
interface TailOffsets {
  transcript: number;
  events: number;
  tasks: number;
  hands: number;
  piMessages: number;
}

interface ReceivedInputCapture {
  taskKey: string;
  title: string;
  task: Record<string, unknown>;
  matchingHandoffRecords: Array<Record<string, unknown>>;
  routingContext: Record<string, unknown>;
  artifactIndex: Record<string, unknown>;
  basePrompt: string;
  handoffContext: string;
  prompt: string;
}

let busy = false;
let tailOffsets: TailOffsets = { transcript: 0, events: 0, tasks: 0, hands: 0, piMessages: 0 };
const partialLogState = new Map<string, { text: string; loggedAt: number }>();

ensureLayout();
console.log(`[meeting-agent] ${agentId} backend=${backend} autorun=${autorun} api=${api}`);
primeConversationTail();
setInterval(() => {
  pollConversationStream();
}, 750);
setInterval(() => {
  void tick();
}, 1500);
pollConversationStream();
void tick();

async function tick(): Promise<void> {
  if (busy || !autorun) return;
  busy = true;
  try {
    const next = listTaskDirs(implementationTaskQueuedRoot)[0];
    if (!next) return;
    const queuedDir = resolve(implementationTaskQueuedRoot, next);
    const workingDir = resolve(implementationTaskWorkingRoot, next);
    rmSync(workingDir, { recursive: true, force: true });
    renameSync(queuedDir, workingDir);
    const task = readJsonFile(resolve(workingDir, "task.json"));
    await processTask(next, workingDir, task);
  } catch (error) {
    console.error(`[meeting-agent] task processing failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  } finally {
    busy = false;
  }
}

async function processTask(taskKey: string, workingDir: string, task: Record<string, unknown>): Promise<void> {
  const title = String(task.title || taskKey);
  const details = typeof task.details === "string" ? task.details : "";
  const basePrompt = typeof task.implementationPrompt === "string" && task.implementationPrompt.trim()
    ? task.implementationPrompt
    : buildPrompt(title, details, task);
  const handoffContext = buildHandoffContextBlock(workingDir);
  const prompt = [basePrompt, handoffContext].filter(Boolean).join("\n\n");
  const matchingHandoffRecords = readTaskHandoffRecords(taskKey);
  const receivedInput: ReceivedInputCapture = {
    taskKey,
    title,
    task,
    matchingHandoffRecords,
    routingContext: buildRoutingContext({ taskKey, task, matchingHandoffRecords, workingDir }),
    artifactIndex: readArtifactIndexSnapshot(),
    basePrompt,
    handoffContext,
    prompt
  };

  await postEvent({
    id: newEventId("task"),
    type: "agent.task",
    stream: "implementation",
    meetingId,
    createdAt: nowIso(),
    agentId,
    taskKey,
    title,
    status: "working",
    taskClass: normalizeTaskClass(task.taskClass),
    details
  } as AgentTaskEvent);

  mkdirSync(workingDir, { recursive: true });
  writeFileSync(resolve(workingDir, "received-input.json"), `${JSON.stringify(receivedInput, null, 2)}\n`, "utf8");
  writeFileSync(resolve(workingDir, "received-input.md"), buildReceivedInputMarkdown(receivedInput), "utf8");
  writeFileSync(resolve(workingDir, "context.md"), handoffContext.endsWith("\n") ? handoffContext : `${handoffContext}\n`, "utf8");
  writeFileSync(resolve(workingDir, "worker.json"), `${JSON.stringify({ agentId, backend, startedAt: nowIso(), prompt }, null, 2)}\n`, "utf8");
  const result = await runLocalAgent(prompt);
  const summary = summarizeResult(result);
  mkdirSync(workingDir, { recursive: true });
  writeFileSync(resolve(workingDir, "result.md"), summary.endsWith("\n") ? summary : `${summary}\n`, "utf8");

  const artifactResult = await createSmartArtifact(taskKey, title, summary);
  const selectedArtifactPath = findPreferredArtifactPath(summary, artifactResult.path);
  const selectedArtifactMarkdown = readArtifactMarkdown(selectedArtifactPath);
  const status: AgentTaskEvent["status"] = result.ok ? "done" : "failed";
  const finalDir = resolve(status === "done" ? implementationTaskDoneRoot : implementationTaskFailedRoot, taskKey);
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(workingDir, finalDir);
  const nextTask = {
    ...task,
    status,
    completedAt: nowIso(),
    artifactPath: artifactResult.path,
    selectedArtifactPath,
    result
  };
  writeFileSync(resolve(finalDir, "task.json"), `${JSON.stringify(nextTask, null, 2)}\n`, "utf8");

  await postEvent({
    id: newEventId("task"),
    type: "agent.task",
    stream: "implementation",
    meetingId,
    createdAt: nowIso(),
    agentId,
    taskKey,
    title,
    status,
    taskClass: normalizeTaskClass(task.taskClass),
    details: details || summarizeForTaskDetails(summary),
    previewUrl: selectedArtifactPath || artifactResult.path
  } as AgentTaskEvent);

  if (result.ok) {
    await postEvent({
      id: newEventId("msg"),
      type: "agent.message",
      stream: "implementation",
      meetingId,
      createdAt: nowIso(),
      agentId,
      format: "markdown",
      surface: "status",
      lifecycle: "final",
      text: `Pi agent completed **${title}**.${selectedArtifactPath ? ` Artifact: \`${selectedArtifactPath}\`.` : ""}`
    } as MeetingEvent);
    if (selectedArtifactPath && selectedArtifactMarkdown) {
      await postEvent({
        id: newEventId("msg"),
        type: "agent.message",
        stream: "implementation",
        meetingId,
        createdAt: nowIso(),
        agentId,
        format: "markdown",
        surface: "canvas",
        lifecycle: "final",
        documentId: selectedArtifactPath,
        text: selectedArtifactMarkdown
      } as MeetingEvent);
    } else {
      await postEvent({
        id: newEventId("msg"),
        type: "agent.message",
        stream: "implementation",
        meetingId,
        createdAt: nowIso(),
        agentId,
        format: "markdown",
        surface: "canvas",
        lifecycle: "final",
        documentId: `task-result:${taskKey}`,
        text: `# ${title}\n\n${summary}${artifactResult.path ? `\n\nArtifact path: \`${artifactResult.path}\`` : ""}`
      } as MeetingEvent);
    }
    await postEvent({
      id: newEventId("hand"),
      type: "agent.hand_raise",
      stream: "conversation",
      meetingId,
      createdAt: nowIso(),
      agentId,
      reason: `I completed "${title}" and can show the result.`,
      confidence: 0.94,
      requestedMode: "show"
    } as MeetingEvent);
  }
}

async function createSmartArtifact(taskKey: string, title: string, summary: string): Promise<{ path?: string }> {
  const result = await runProcess("node", [
    "scripts/smart-artifact.mjs",
    "write",
    "--kind",
    "implementation",
    "--slug",
    taskKey,
    "--title",
    title,
    "--summary",
    `Pi agent implementation output for ${title}`,
    "--body",
    summary
  ]);
  const path = result.stdout.trim().split("\n").pop() || undefined;
  return { path };
}

async function postEvent(event: MeetingEvent): Promise<void> {
  await fetch(`${api}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event)
  });
}

async function runLocalAgent(prompt: string): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  if (backend === "claude") return runProcess("claude", ["-p", prompt]);
  return runProcess("codex", ["exec", "--dangerously-bypass-approvals-and-sandbox", "--sandbox", "danger-full-access", "--cd", root, "--", prompt]);
}

function runProcess(command: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolvePromise({ ok: false, stdout, stderr: error.message, code: null }));
    child.on("close", (code) => resolvePromise({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code }));
  });
}

function ensureLayout(): void {
  for (const dir of [
    resolve(conversationRoot, "transcript"),
    resolve(conversationRoot, "notes"),
    resolve(conversationRoot, "hands"),
    implementationInboxRoot,
    implementationTaskQueuedRoot,
    implementationTaskWorkingRoot,
    implementationTaskDoneRoot,
    implementationTaskFailedRoot
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

function listTaskDirs(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function buildPrompt(title: string, details: string, task: Record<string, unknown>): string {
  const sourceDocumentId = typeof task.sourceDocumentId === "string" ? task.sourceDocumentId : "";
  return [
    `You are ${agentId}, the implementation agent for the Meeting app.`,
    `Implementation task: ${title}`,
    details ? `Details:\n${details}` : "",
    sourceDocumentId ? `Source document: ${sourceDocumentId}` : "",
    "Work in the current repository and improve the real app so hot reload reflects the change.",
    "Return a concise summary of what changed, verification performed, and any remaining limitations."
  ].filter(Boolean).join("\n\n");
}

function buildReceivedInputMarkdown(input: ReceivedInputCapture): string {
  return [
    "# Pi-Agent Received Input",
    "",
    "## Task Fields Seen By Worker",
    "",
    "```json",
    safeJson({ taskKey: input.taskKey, title: input.title, task: input.task }),
    "```",
    "",
    "## Routing / Context Fields Seen By Worker",
    "",
    "```json",
    safeJson(input.routingContext),
    "```",
    "",
    "## Artifact Index Seen By Worker",
    "",
    "```json",
    safeJson(input.artifactIndex),
    "```",
    "",
    "## Matching Realtime Handoff Records",
    "",
    input.matchingHandoffRecords.length ? [
      "```json",
      safeJson(input.matchingHandoffRecords),
      "```"
    ].join("\n") : "_No matching records found in pi-handoffs.jsonl._",
    "",
    "## Base Prompt",
    "",
    fencedText(input.basePrompt),
    "",
    "## Appended Handoff Context",
    "",
    fencedText(input.handoffContext),
    "",
    "## Exact Prompt Sent To Local Agent",
    "",
    fencedText(input.prompt)
  ].join("\n").concat("\n");
}

function readTaskHandoffRecords(taskKey: string): Array<Record<string, unknown>> {
  return tailJsonl(piHandoffsPath, 500).filter((record) => record.taskKey === taskKey);
}

function buildRoutingContext(input: { taskKey: string; task: Record<string, unknown>; matchingHandoffRecords: Array<Record<string, unknown>>; workingDir: string }): Record<string, unknown> {
  const handoffSummary = input.matchingHandoffRecords.find((record) => record.kind === "handoff_summary");
  const sourceDocumentId = stringField(input.task.sourceDocumentId) || stringField(handoffSummary?.sourceDocumentId);
  return {
    taskKey: input.taskKey,
    taskId: stringField(input.task.id),
    mirroredFromEventId: stringField(input.task.mirroredFromEventId),
    stream: stringField(input.task.stream),
    meetingId: stringField(input.task.meetingId),
    agentId: stringField(input.task.agentId),
    status: stringField(input.task.status),
    taskClass: stringField(input.task.taskClass),
    sourceDocumentId,
    cwd: stringField(handoffSummary?.cwd) || root,
    receivedInputPath: resolve(input.workingDir, "received-input.md"),
    implementationConversationInboxPath,
    piHandoffsPath,
    artifactIndexPath: artifactsIndexPath,
    artifactIndexCount: artifactIndexCount(),
    matchingHandoffRecordCount: input.matchingHandoffRecords.length,
    matchingHandoffRecordKinds: [...new Set(input.matchingHandoffRecords.map((record) => stringField(record.kind)).filter(Boolean))]
  };
}

function readArtifactIndexSnapshot(): Record<string, unknown> {
  if (!existsSync(artifactsIndexPath)) return { path: artifactsIndexPath, missing: true };
  const raw = readTextIfExists(artifactsIndexPath);
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { path: artifactsIndexPath, ...(parsed as Record<string, unknown>) }
      : { path: artifactsIndexPath, error: "artifact index is not a JSON object", raw };
  } catch (error) {
    return { path: artifactsIndexPath, error: error instanceof Error ? error.message : String(error), raw };
  }
}

function artifactIndexCount(): number {
  const snapshot = readArtifactIndexSnapshot();
  return Array.isArray(snapshot.artifacts) ? snapshot.artifacts.length : 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function findPreferredArtifactPath(text: string, fallbackPath?: string): string | undefined {
  const paths = [...text.matchAll(/[^\s`'")]*artifacts\/[^\s`'")]+\/artifact\.smart\.md/g)]
    .map((match) => normalizeArtifactPath(match[0]))
    .filter((path): path is string => Boolean(path));
  const uniquePaths = [...new Set(paths)];
  const preferred = [...uniquePaths].reverse().find((path) => path !== fallbackPath && !path.includes("/implementation-"));
  return preferred || uniquePaths[uniquePaths.length - 1] || fallbackPath;
}

function normalizeArtifactPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, "/").replace(/[.,;:]+$/g, "");
  if (normalized.startsWith("artifacts/")) return normalized;
  const marker = "/artifacts/";
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(index + 1) : undefined;
}

function readArtifactMarkdown(artifactPath: string | undefined): string {
  const normalized = normalizeArtifactPath(artifactPath);
  if (!normalized) return "";
  const artifactsRoot = resolve(root, "artifacts");
  const filePath = resolve(root, normalized);
  if (filePath !== artifactsRoot && !filePath.startsWith(`${artifactsRoot}/`)) return "";
  return readTextIfExists(filePath);
}

function summarizeForTaskDetails(text: string): string {
  return compact(text.replace(/\s+/g, " "), 700);
}

function primeConversationTail(): void {
  tailOffsets = {
    transcript: fileSize(conversationTranscriptJsonlPath),
    events: fileSize(conversationEventsPath),
    tasks: fileSize(conversationTasksPath),
    hands: fileSize(conversationHandsPath),
    piMessages: fileSize(piDirectMessagesPath)
  };
  console.log(`[meeting-agent] tailing Realtime/Whisper conversation stream from ${conversationRoot}`);
  const recentTranscript = tailTextFile(conversationTranscriptMdPath, 6).join("\n");
  if (recentTranscript) console.log(`[meeting-agent:context] recent transcript\n${recentTranscript}`);
  const currentCanvas = compact(readTextIfExists(conversationCurrentNotePath), 900);
  if (currentCanvas) console.log(`[meeting-agent:context] current canvas\n${currentCanvas}`);
}

function pollConversationStream(): void {
  const transcript = readAppendedLines(conversationTranscriptJsonlPath, tailOffsets.transcript);
  tailOffsets.transcript = transcript.offset;
  for (const line of transcript.lines) handleConversationRecord(line, "transcript");

  const events = readAppendedLines(conversationEventsPath, tailOffsets.events);
  tailOffsets.events = events.offset;
  for (const line of events.lines) handleConversationRecord(line, "event");

  const tasks = readAppendedLines(conversationTasksPath, tailOffsets.tasks);
  tailOffsets.tasks = tasks.offset;
  for (const line of tasks.lines) handleConversationRecord(line, "task");

  const hands = readAppendedLines(conversationHandsPath, tailOffsets.hands);
  tailOffsets.hands = hands.offset;
  for (const line of hands.lines) handleConversationRecord(line, "hand");

  const piMessages = readAppendedLines(piDirectMessagesPath, tailOffsets.piMessages);
  tailOffsets.piMessages = piMessages.offset;
  for (const line of piMessages.lines) handlePiDirectMessage(line);
}

function handleConversationRecord(line: string, source: "transcript" | "event" | "task" | "hand"): void {
  const event = parseJsonLine(line);
  if (!event) return;
  if (source === "transcript") {
    if (event.type === "utterance.partial") {
      maybeLogPartial(event);
      return;
    }
    if (event.type === "utterance.final") {
      const speaker = typeof event.speakerLabel === "string" ? event.speakerLabel : "Host";
      const text = typeof event.text === "string" ? event.text : "";
      console.log(`[meeting-agent:transcript] ${speaker}: ${compact(text, 420)}`);
      return;
    }
  }
  if (source === "event" && event.type === "agent.message") {
    const text = typeof event.text === "string" ? event.text : "";
    console.log(`[meeting-agent:canvas] ${compact(text.replace(/\s+/g, " "), 420)}`);
    return;
  }
  if (source === "task" && event.type === "agent.task") {
    console.log(`[meeting-agent:task] ${event.status || "queued"} ${event.title || event.taskKey || "untitled task"}`);
    return;
  }
  if (source === "hand" && event.type === "agent.hand_raise") {
    console.log(`[meeting-agent:hand] ${compact(String(event.reason || ""), 420)}`);
  }
}

function handlePiDirectMessage(line: string): void {
  const message = parseJsonLine(line);
  if (!message) return;
  const intent = typeof message.intent === "string" ? message.intent : "inform";
  const text = typeof message.text === "string" ? message.text : "";
  const taskKey = typeof message.taskKey === "string" ? ` task=${message.taskKey}` : "";
  console.log(`[meeting-agent:direct:${intent}]${taskKey} ${compact(text, 800)}`);
}

function maybeLogPartial(event: Record<string, unknown>): void {
  const itemId = typeof event.id === "string" ? event.id : "partial";
  const text = typeof event.text === "string" ? event.text : "";
  if (!text.trim()) return;
  const previous = partialLogState.get(itemId);
  const now = Date.now();
  if (previous && text.length - previous.text.length < 48 && now - previous.loggedAt < 2500) return;
  partialLogState.set(itemId, { text, loggedAt: now });
  const speaker = typeof event.speakerLabel === "string" ? event.speakerLabel : "Host";
  console.log(`[meeting-agent:partial] ${speaker}: ${compact(text, 240)}`);
}

function buildHandoffContextBlock(workingDir?: string): string {
  return [
    "## Meeting Handoff Contract",
    "The task prompt above is the Realtime agent's concise handoff summary.",
    "Do not treat raw conversation as part of the prompt by default.",
    `If extra provenance is needed, inspect JSONL records at ${implementationConversationInboxPath}.`,
    "Inbox schema: { ts, role: user|realtime-agent, kind: raw_user_comm|raw_agent_comm|hint, text, ...metadata }.",
    workingDir ? `For exact input/debug requests, inspect ${resolve(workingDir, "received-input.md")} for the exact prompt sent to the local agent plus matching Realtime handoff fields.` : "",
    "Answer through Meeting tools/artifacts so the Realtime agent and host can review or speak about the result."
  ].filter(Boolean).join("\n\n");
}

function readAppendedLines(path: string, offset: number): { lines: string[]; offset: number } {
  if (!existsSync(path)) return { lines: [], offset: 0 };
  const buffer = readFileSync(path);
  const safeOffset = offset > buffer.length ? 0 : offset;
  const text = buffer.subarray(safeOffset).toString("utf8");
  return {
    lines: text.split("\n").map((line) => line.trim()).filter(Boolean),
    offset: buffer.length
  };
}

function fileSize(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path).byteLength;
}

function readTextIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function tailTextFile(path: string, count: number): string[] {
  return readTextIfExists(path).split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-count);
}

function tailJsonl(path: string, count: number): Array<Record<string, unknown>> {
  return tailTextFile(path, count).map(parseJsonLine).filter((event): event is Record<string, unknown> => Boolean(event));
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function compact(text: string, maxLength: number): string {
  return clampText(text.trim().replace(/\s+/g, " "), maxLength);
}

function clampText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function fencedText(text: string): string {
  return `\`\`\`txt\n${text.replace(/```/g, "`\u200b``")}\n\`\`\``;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/```/g, "`\u200b``");
}

function summarizeResult(result: { ok: boolean; stdout: string; stderr: string; code: number | null }): string {
  return [
    "## Outcome",
    result.ok ? "Completed successfully." : `Failed with code ${result.code ?? "unknown"}.`,
    "",
    result.stdout ? `## Pi Agent Summary\n\n${result.stdout}` : "",
    result.stderr ? `## Stderr\n\n\`\`\`text\n${result.stderr}\n\`\`\`` : ""
  ].filter(Boolean).join("\n");
}

function normalizeTaskClass(value: unknown): AgentTaskEvent["taskClass"] {
  return value === "artifact.render"
    || value === "artifact.edit"
    || value === "code.change"
    || value === "research.explore"
    || value === "critique.review"
    || value === "conversation"
    ? value
    : undefined;
}

function resolveRepoRoot(): string {
  const cwd = process.cwd();
  return cwd.replace(/\\/g, "/").endsWith("/apps/agent-worker") ? resolve(cwd, "../..") : cwd;
}
