export type MeetingId = string;
export type AgentId = string;
export type ParticipantId = string;
export type MeetingStream = "conversation" | "implementation";
export type MeetingTaskClass =
  | "artifact.render"
  | "artifact.edit"
  | "code.change"
  | "research.explore"
  | "critique.review"
  | "conversation";

export type MeetingEvent =
  | UtteranceEvent
  | PartialUtteranceEvent
  | AgentHandRaiseEvent
  | AgentFloorEvent
  | AgentMessageEvent
  | AgentTaskEvent
  | AgentTraceEvent
  | RepositoryContextEvent
  | SystemEvent;

export interface BaseEvent {
  id: string;
  meetingId: MeetingId;
  createdAt: string;
}

export interface UtteranceEvent extends BaseEvent {
  type: "utterance.final";
  stream?: MeetingStream;
  speakerId: ParticipantId;
  speakerLabel: string;
  text: string;
  startMs: number;
  endMs: number;
  taskClass?: MeetingTaskClass;
}

export interface PartialUtteranceEvent extends BaseEvent {
  type: "utterance.partial";
  stream?: MeetingStream;
  speakerId: ParticipantId;
  speakerLabel: string;
  text: string;
  startMs: number;
}

export interface AgentHandRaiseEvent extends BaseEvent {
  type: "agent.hand_raise";
  stream?: MeetingStream;
  agentId: AgentId;
  reason: string;
  confidence: number;
  requestedMode: "speak" | "show" | "work" | "review";
}

export interface AgentFloorEvent extends BaseEvent {
  type: "agent.floor";
  stream?: MeetingStream;
  agentId: AgentId;
  granted: boolean;
  mode: "speak" | "show" | "work" | "review";
  note?: string;
}

export interface AgentMessageEvent extends BaseEvent {
  type: "agent.message";
  stream?: MeetingStream;
  agentId: AgentId;
  format: "markdown" | "plain";
  text: string;
  surface?: "canvas" | "status";
  lifecycle?: "draft" | "final";
  documentId?: string;
  streaming?: boolean;
}

export interface AgentTraceEvent extends BaseEvent {
  type: "agent.trace";
  stream?: MeetingStream;
  agentId: AgentId;
  channel: "input" | "agent" | "message" | "tool" | "error" | "debug";
  text: string;
  details?: unknown;
}

export interface AgentTaskEvent extends BaseEvent {
  type: "agent.task";
  stream?: MeetingStream;
  agentId: AgentId;
  taskKey?: string;
  status: "queued" | "working" | "blocked" | "done" | "failed";
  title: string;
  taskClass?: MeetingTaskClass;
  repository?: RepositoryContext;
  branch?: string;
  previewUrl?: string;
  details?: string;
  implementationPrompt?: string;
  sourceDocumentId?: string;
}

export interface RepositoryContextEvent extends BaseEvent {
  type: "repository.context";
  repository: RepositoryContext;
}

export interface RepositoryContext {
  owner: string;
  name: string;
  cloneUrl?: string;
  localPath?: string;
  baseBranch: string;
}

export interface SystemEvent extends BaseEvent {
  type: "system";
  level: "info" | "warn" | "error";
  text: string;
}

export function newEventId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface AssistantStatusTemplateInput {
  status?: string;
  confidence?: string;
  next?: string;
  statusMarkdown?: string;
}

export function formatAssistantStatusMarkdown(input: AssistantStatusTemplateInput): string {
  const explicit = cleanText(input.statusMarkdown);
  if (explicit) {
    assertAssistantStatusTemplate(explicit);
    return explicit;
  }

  const status = cleanText(input.status);
  const confidence = cleanText(input.confidence);
  const next = cleanText(input.next);
  if (!status && !confidence && !next) return "";
  if (!status || !confidence || !next) {
    throw new Error("status, confidence, and next are required for assistant status delivery");
  }

  return [
    `Status: ${status}`,
    `Confidence: ${confidence}`,
    `Next: ${next}`
  ].join("\n");
}

export function isAssistantStatusTemplate(markdown: string): boolean {
  const lines = terminalStatusLines(markdown);
  return lines.length === 3
    && lines[0].startsWith("Status: ")
    && lines[1].startsWith("Confidence: ")
    && lines[2].startsWith("Next: ");
}

export function assertAssistantStatusTemplate(markdown: string): void {
  if (!isAssistantStatusTemplate(markdown)) {
    throw new Error("assistant status must use exactly three lines: Status, Confidence, Next");
  }
}

export function formatAssistantCanvasMarkdown(title: string | undefined, markdown: string): string {
  const body = markdown.trim();
  if (!body) return "";
  const cleanTitle = cleanText(title);
  if (!cleanTitle || firstMarkdownLine(body).startsWith("# ")) return body;
  return `# ${cleanTitle}\n\n${body}`;
}

export function firstMarkdownHeading(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

function terminalStatusLines(markdown: string): string[] {
  return markdown.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function firstMarkdownLine(markdown: string): string {
  return markdown.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
