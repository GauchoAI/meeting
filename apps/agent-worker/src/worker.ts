import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { newEventId, nowIso, type AgentTaskEvent, type MeetingEvent } from "@meeting/protocol";

const api = process.env.MEETING_API_URL || "http://localhost:4317";
const root = resolve(process.cwd(), "../..");
const meetingId = process.env.MEETING_ID || "local-demo";
const agentId = process.env.MEETING_AGENT_ID || "pi-agent";
const backend = process.env.MEETING_AGENT_BACKEND || "codex";
const autorun = process.env.MEETING_AGENT_AUTORUN !== "false";
const pipelineRoot = resolve(root, ".meeting/pipeline");
const implementationTaskQueuedRoot = resolve(pipelineRoot, "implementation/tasks/queued");
const implementationTaskWorkingRoot = resolve(pipelineRoot, "implementation/tasks/working");
const implementationTaskDoneRoot = resolve(pipelineRoot, "implementation/tasks/done");
const implementationTaskFailedRoot = resolve(pipelineRoot, "implementation/tasks/failed");
let busy = false;

ensureLayout();
console.log(`[meeting-agent] ${agentId} backend=${backend} autorun=${autorun} api=${api}`);
setInterval(() => {
  void tick();
}, 1500);
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
  } finally {
    busy = false;
  }
}

async function processTask(taskKey: string, workingDir: string, task: Record<string, unknown>): Promise<void> {
  const title = String(task.title || taskKey);
  const details = typeof task.details === "string" ? task.details : "";
  const prompt = typeof task.implementationPrompt === "string" && task.implementationPrompt.trim()
    ? task.implementationPrompt
    : buildPrompt(title, details, task);

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

  writeFileSync(resolve(workingDir, "worker.json"), `${JSON.stringify({ agentId, backend, startedAt: nowIso(), prompt }, null, 2)}\n`, "utf8");
  const result = await runLocalAgent(prompt);
  const summary = summarizeResult(result);
  writeFileSync(resolve(workingDir, "result.md"), summary.endsWith("\n") ? summary : `${summary}\n`, "utf8");

  const artifactResult = await createSmartArtifact(taskKey, title, summary);
  const status: AgentTaskEvent["status"] = result.ok ? "done" : "failed";
  const finalDir = resolve(status === "done" ? implementationTaskDoneRoot : implementationTaskFailedRoot, taskKey);
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(workingDir, finalDir);
  const nextTask = {
    ...task,
    status,
    completedAt: nowIso(),
    artifactPath: artifactResult.path,
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
    details: details || summary,
    previewUrl: artifactResult.path
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
      text: `Pi agent completed **${title}**.${artifactResult.path ? ` Artifact: \`${artifactResult.path}\`.` : ""}`
    } as MeetingEvent);
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
  for (const dir of [implementationTaskQueuedRoot, implementationTaskWorkingRoot, implementationTaskDoneRoot, implementationTaskFailedRoot]) {
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
