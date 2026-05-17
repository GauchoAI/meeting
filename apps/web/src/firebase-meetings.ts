export interface PublicMeetingRecord {
  id: string;
  title: string;
  host: { id: string; name: string };
  apiUrl: string;
  signalingRoomId: string;
  visibility: "public" | "invite-only";
  participantCount: number;
  updatedAtMs: number;
}

export interface AdvertiseMeetingOptions {
  meetingId: string;
  title: string;
  hostId: string;
  hostName: string;
  apiUrl: string;
  signalingRoomId?: string;
  visibility?: "public" | "invite-only";
  participantCount?: number;
  heartbeatMs?: number;
}

const defaultDatabaseUrl = "https://signaling-dcfad-default-rtdb.europe-west1.firebasedatabase.app";
const defaultNamespace = "gauchoai-meeting";

function databaseUrl(): string {
  return String(import.meta.env.VITE_FIREBASE_DATABASE_URL || defaultDatabaseUrl).replace(/\/+$/, "");
}

function namespacePath(): string {
  return String(import.meta.env.VITE_FIREBASE_NAMESPACE || defaultNamespace)
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "-");
}

function pathUrl(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  return `${databaseUrl()}/${namespacePath()}/${clean}.json`;
}

function meetingPath(meetingId: string): string {
  return `publicMeetings/${encodeURIComponent(meetingId).replace(/\./g, "%2E")}`;
}

function normalizeMeeting(id: string, value: unknown): PublicMeetingRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PublicMeetingRecord>;
  return {
    id,
    title: String(record.title || id),
    host: {
      id: String(record.host?.id || "host"),
      name: String(record.host?.name || "Host")
    },
    apiUrl: String(record.apiUrl || ""),
    signalingRoomId: String(record.signalingRoomId || id),
    visibility: record.visibility === "invite-only" ? "invite-only" : "public",
    participantCount: Number(record.participantCount || 1),
    updatedAtMs: Number(record.updatedAtMs || 0)
  };
}

function freshPublicMeetings(values: Record<string, unknown>): PublicMeetingRecord[] {
  const now = Date.now();
  const freshWindowMs = 45_000;
  return Object.entries(values || {})
    .map(([id, value]) => normalizeMeeting(id, value))
    .filter((meeting): meeting is PublicMeetingRecord => Boolean(meeting))
    .filter((meeting) => meeting.visibility === "public" && Boolean(meeting.apiUrl) && now - meeting.updatedAtMs <= freshWindowMs)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function firebaseMeetingConfigStatus(): { configured: boolean; message: string } {
  return {
    configured: true,
    message: `Firebase Realtime Database registry: ${databaseUrl()}/${namespacePath()}/publicMeetings`
  };
}

export function subscribePublicMeetings(onMeetings: (meetings: PublicMeetingRecord[]) => void, onError?: (error: Error) => void): () => void {
  const url = pathUrl("publicMeetings");
  let closed = false;
  let lastValues: Record<string, unknown> = {};
  let pollTimer = 0;
  let eventSource: EventSource | null = null;

  const publish = () => onMeetings(freshPublicMeetings(lastValues));

  const fetchSnapshot = async () => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Firebase lobby fetch failed: ${response.status}`);
      lastValues = (await response.json()) || {};
      publish();
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const startPolling = () => {
    if (pollTimer) return;
    void fetchSnapshot();
    pollTimer = window.setInterval(() => void fetchSnapshot(), 10_000);
  };

  try {
    eventSource = new EventSource(url);
    eventSource.addEventListener("put", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { path: string; data: unknown };
        if (payload.path === "/") {
          lastValues = (payload.data as Record<string, unknown>) || {};
        } else {
          const key = payload.path.replace(/^\//, "").split("/")[0];
          if (key) {
            if (payload.data === null) delete lastValues[key];
            else lastValues[key] = payload.data;
          }
        }
        publish();
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    eventSource.addEventListener("patch", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { path: string; data: Record<string, unknown> };
        if (payload.path === "/") lastValues = { ...lastValues, ...payload.data };
        publish();
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    eventSource.onerror = () => {
      if (!closed) startPolling();
    };
  } catch {
    startPolling();
  }

  void fetchSnapshot();
  const freshnessTimer = window.setInterval(publish, 5000);

  return () => {
    closed = true;
    eventSource?.close();
    window.clearInterval(freshnessTimer);
    if (pollTimer) window.clearInterval(pollTimer);
  };
}

export function advertisePublicMeeting(options: AdvertiseMeetingOptions, onError?: (error: Error) => void): () => void {
  const heartbeatMs = Math.max(5000, options.heartbeatMs || 10_000);
  let stopped = false;

  const publish = async () => {
    if (stopped) return;
    try {
      const response = await fetch(pathUrl(meetingPath(options.meetingId)), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: options.title,
          host: { id: options.hostId, name: options.hostName },
          apiUrl: options.apiUrl,
          signalingRoomId: options.signalingRoomId || options.meetingId,
          visibility: options.visibility || "public",
          participantCount: options.participantCount || 1,
          updatedAtMs: Date.now()
        })
      });
      if (!response.ok) throw new Error(`Firebase advertisement failed: ${response.status}`);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  void publish();
  const timer = window.setInterval(() => void publish(), heartbeatMs);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    void fetch(pathUrl(meetingPath(options.meetingId)), { method: "DELETE" }).catch((error) => onError?.(error instanceof Error ? error : new Error(String(error))));
  };
}
