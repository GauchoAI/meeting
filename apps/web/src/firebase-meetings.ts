import { initializeApp, type FirebaseApp } from "firebase/app";
import { collection, deleteDoc, doc, getFirestore, onSnapshot, orderBy, query, serverTimestamp, setDoc, type Firestore } from "firebase/firestore";

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

let app: FirebaseApp | null = null;
let firestore: Firestore | null = null;

export function firebaseMeetingConfigStatus(): { configured: boolean; message: string } {
  if (!import.meta.env.VITE_FIREBASE_API_KEY) return { configured: false, message: "VITE_FIREBASE_API_KEY is not configured." };
  if (!import.meta.env.VITE_FIREBASE_PROJECT_ID) return { configured: false, message: "VITE_FIREBASE_PROJECT_ID is not configured." };
  if (!import.meta.env.VITE_FIREBASE_APP_ID) return { configured: false, message: "VITE_FIREBASE_APP_ID is not configured." };
  return { configured: true, message: "Firebase meeting registry configured." };
}

function db(): Firestore | null {
  const status = firebaseMeetingConfigStatus();
  if (!status.configured) return null;
  if (!app) {
    app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID
    });
  }
  firestore ||= getFirestore(app);
  return firestore;
}

export function subscribePublicMeetings(onMeetings: (meetings: PublicMeetingRecord[]) => void, onError?: (error: Error) => void): () => void {
  const store = db();
  if (!store) {
    onMeetings([]);
    return () => undefined;
  }
  const publicMeetings = query(collection(store, "publicMeetings"), orderBy("updatedAtMs", "desc"));
  return onSnapshot(publicMeetings, (snapshot) => {
    const now = Date.now();
    const freshWindowMs = 45_000;
    const meetings = snapshot.docs
      .map((entry) => ({ id: entry.id, ...entry.data() }) as PublicMeetingRecord)
      .filter((meeting) => meeting.visibility === "public" && now - Number(meeting.updatedAtMs || 0) <= freshWindowMs);
    onMeetings(meetings);
  }, (error) => onError?.(error));
}

export function advertisePublicMeeting(options: AdvertiseMeetingOptions, onError?: (error: Error) => void): () => void {
  const store = db();
  if (!store) return () => undefined;

  const meetingRef = doc(store, "publicMeetings", options.meetingId);
  const heartbeatMs = Math.max(5000, options.heartbeatMs || 10_000);
  let stopped = false;

  const publish = async () => {
    if (stopped) return;
    try {
      await setDoc(meetingRef, {
        title: options.title,
        host: { id: options.hostId, name: options.hostName },
        apiUrl: options.apiUrl,
        signalingRoomId: options.signalingRoomId || options.meetingId,
        visibility: options.visibility || "public",
        participantCount: options.participantCount || 1,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now()
      }, { merge: true });
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  void publish();
  const timer = window.setInterval(() => void publish(), heartbeatMs);

  return () => {
    stopped = true;
    window.clearInterval(timer);
    void deleteDoc(meetingRef).catch((error) => onError?.(error instanceof Error ? error : new Error(String(error))));
  };
}
