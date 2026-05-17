import type { MeetingSignal, MeetingSignalingAdapter } from "./multi-human-room.js";

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

function cleanKey(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function pathUrl(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  return `${databaseUrl()}/${namespacePath()}/${clean}.json`;
}

interface StoredSignal {
  signal: MeetingSignal;
  createdAtMs: number;
}

export class FirebaseRealtimeSignalingAdapter implements MeetingSignalingAdapter {
  async publish(signal: MeetingSignal): Promise<void> {
    const response = await fetch(pathUrl(`signalingRooms/${cleanKey(signal.roomId)}/signals`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signal, createdAtMs: Date.now() } satisfies StoredSignal)
    });
    if (!response.ok) throw new Error(`Firebase signaling publish failed: ${response.status}`);
  }

  async subscribe(roomId: string, onSignal: (signal: MeetingSignal) => void): Promise<() => void> {
    const url = pathUrl(`signalingRooms/${cleanKey(roomId)}/signals`);
    const seen = new Set<string>();
    let closed = false;
    let pollTimer = 0;
    let eventSource: EventSource | null = null;

    const accept = (id: string, value: unknown) => {
      if (seen.has(id) || !value || typeof value !== "object") return;
      const stored = value as Partial<StoredSignal>;
      if (!stored.signal) return;
      seen.add(id);
      onSignal(stored.signal);
    };

    const acceptSnapshot = (values: Record<string, unknown>) => {
      for (const [id, value] of Object.entries(values || {})) accept(id, value);
    };

    const fetchSnapshot = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) throw new Error(`Firebase signaling fetch failed: ${response.status}`);
        acceptSnapshot((await response.json()) || {});
      } catch {
        // Keep signaling best-effort; the caller can still retry via future heartbeats.
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      void fetchSnapshot();
      pollTimer = window.setInterval(() => void fetchSnapshot(), 2000);
    };

    try {
      eventSource = new EventSource(url);
      eventSource.addEventListener("put", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { path: string; data: unknown };
        if (payload.path === "/") acceptSnapshot((payload.data as Record<string, unknown>) || {});
        else accept(payload.path.replace(/^\//, "").split("/")[0] || `${Date.now()}`, payload.data);
      });
      eventSource.addEventListener("patch", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as { data: Record<string, unknown> };
        acceptSnapshot(payload.data || {});
      });
      eventSource.onerror = () => {
        if (!closed) startPolling();
      };
    } catch {
      startPolling();
    }

    void fetchSnapshot();

    return () => {
      closed = true;
      eventSource?.close();
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }
}

export async function pruneFirebaseSignalingRoom(roomId: string, olderThanMs = 5 * 60_000): Promise<void> {
  const url = pathUrl(`signalingRooms/${cleanKey(roomId)}/signals`);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return;
  const values = (await response.json()) as Record<string, StoredSignal> | null;
  const cutoff = Date.now() - olderThanMs;
  await Promise.all(Object.entries(values || {})
    .filter(([, value]) => Number(value?.createdAtMs || 0) < cutoff)
    .map(([id]) => fetch(pathUrl(`signalingRooms/${cleanKey(roomId)}/signals/${id}`), { method: "DELETE" }).catch(() => undefined)));
}
