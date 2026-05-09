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
