export type MeetingTaskClass =
  | "artifact.render"
  | "artifact.edit"
  | "code.change"
  | "research.explore"
  | "critique.review"
  | "conversation";

export interface MeetingRouteRequest {
  taskClass: MeetingTaskClass;
  source: string;
}

const state: { next?: MeetingRouteRequest } = {};

export function setNextMeetingRoute(request: MeetingRouteRequest): void {
  state.next = request;
}

export function consumeNextMeetingRoute(): MeetingRouteRequest | undefined {
  const next = state.next;
  state.next = undefined;
  return next;
}

export function peekNextMeetingRoute(): MeetingRouteRequest | undefined {
  return state.next;
}

export function isMeetingTaskClass(value: unknown): value is MeetingTaskClass {
  return value === "artifact.render"
    || value === "artifact.edit"
    || value === "code.change"
    || value === "research.explore"
    || value === "critique.review"
    || value === "conversation";
}
