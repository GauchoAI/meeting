import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Mic, Monitor, Phone, Play, Radio, Square, UserRoundCheck, Waves } from "lucide-react";
import { TranscriptBuffer, type TranscriptLine } from "@meeting/transcript";
import { newEventId, nowIso, type AgentHandRaiseEvent, type AgentMessageEvent, type MeetingEvent } from "@meeting/protocol";
// markdown2.html.js is intentionally a runtime JS translator file.
// @ts-expect-error TypeScript does not attach declarations to this dotted filename.
import { markdownToHtml } from "./markdown2.html.js";
import "./styles.css";

const api = import.meta.env.VITE_MEETING_API_URL || "http://localhost:4317";
const meetingId = "local-demo";

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const transcript = useMemo(() => new TranscriptBuffer(), []);
  const [events, setEvents] = useState<MeetingEvent[]>([]);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    let alive = true;
    let source: EventSource | undefined;

    void fetch(`${api}/events`)
      .then((response) => response.json() as Promise<{ events: MeetingEvent[] }>)
      .then((snapshot) => {
        if (!alive) return;
        setEvents([...snapshot.events].reverse().slice(0, 100));
        setLines(transcript.applyAll(snapshot.events));
        source = new EventSource(`${api}/events/stream`);
        source.addEventListener("meeting", (message) => {
          const event = JSON.parse((message as MessageEvent).data) as MeetingEvent;
          setEvents((current) => [event, ...current].slice(0, 100));
          setLines(transcript.apply(event));
        });
      })
      .catch((error) => console.warn("event stream failed", error));

    return () => {
      alive = false;
      source?.close();
    };
  }, [transcript]);

  useEffect(() => {
    if (videoRef.current && localStream) {
      videoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const hands = events.filter((event): event is AgentHandRaiseEvent => event.type === "agent.hand_raise");
  const messages = events.filter((event): event is AgentMessageEvent => event.type === "agent.message");
  const tasks = events.filter((event) => event.type === "agent.task");
  const latestMessage = messages[0];

  async function startLocalMedia() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    setLocalStream(stream);
    setConnected(true);
  }

  function stopLocalMedia() {
    stopWhisperCapture();
    localStream?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    setConnected(false);
  }

  async function startWhisperCapture() {
    const stream = localStream || await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (!localStream) setLocalStream(stream);
    const recorder = new MediaRecorder(stream, { mimeType: preferredMimeType() });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        void sendAudioChunk(event.data);
      }
    };
    recorder.start(4500);
    recorderRef.current = recorder;
    setRecording(true);
  }

  function stopWhisperCapture() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  async function grantFloor(hand: AgentHandRaiseEvent, granted: boolean) {
    await postEvent({
      id: newEventId("floor"),
      type: "agent.floor",
      meetingId,
      createdAt: nowIso(),
      agentId: hand.agentId,
      granted,
      mode: hand.requestedMode,
      note: granted ? "Host granted floor." : "Host declined."
    });
  }

  return (
    <main className="shell">
      <section className="stage">
        <header className="topbar">
          <div>
            <h1>Meeting</h1>
            <p>P2P-ready room with transcript-driven local agents.</p>
          </div>
          <div className="status"><Radio size={16} /> {recording ? "local Whisper on" : connected ? "local media on" : "waiting for audio"}</div>
        </header>

        <div className="videoGrid">
          <div className="tile primary">
            {localStream ? <video ref={videoRef} autoPlay muted playsInline /> : <div className="placeholder"><Mic /> Start local camera/mic</div>}
            <span>Host</span>
          </div>
          <div className="tile">
            <div className="placeholder"><UserRoundCheck /> Agent floor</div>
            <span>Agents speak only when invited</span>
          </div>
          <div className="tile artifactTile">
            {latestMessage ? (
              <MarkdownMessage message={latestMessage} expanded />
            ) : (
              <div className="placeholder"><Monitor /> Artifact wall</div>
            )}
            <span>Branches, diagrams, previews</span>
          </div>
        </div>

        <div className="controls">
          {!connected ? (
            <button onClick={startLocalMedia}><Play size={16} /> Start local media</button>
          ) : (
            <button onClick={stopLocalMedia}><Phone size={16} /> Leave local media</button>
          )}
          {!recording ? (
            <button onClick={startWhisperCapture}><Waves size={16} /> Start Whisper</button>
          ) : (
            <button onClick={stopWhisperCapture}><Square size={16} /> Stop Whisper</button>
          )}
          <button onClick={() => void postEvent(systemEvent("P2P signaling is intentionally not connected yet."))}><Square size={16} /> P2P status</button>
        </div>
      </section>

      <aside className="side">
        <section className="panel transcript">
          <h2>Transcript</h2>
          <div className="scroll">
            {lines.map((line, index) => (
              <article key={`${line.speakerId}-${line.startMs}-${index}`} className={line.final ? "" : "partial"}>
                <strong>{line.speakerLabel}</strong>
                <p>{line.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Raised Hands</h2>
          <div className="stack">
            {hands.slice(0, 5).map((hand) => (
              <article key={hand.id} className="hand">
                <strong>{hand.agentId}</strong>
                <p>{hand.reason}</p>
                <div className="row">
                  <button onClick={() => grantFloor(hand, true)}>Grant</button>
                  <button onClick={() => grantFloor(hand, false)}>Decline</button>
                </div>
              </article>
            ))}
            {!hands.length && <p className="muted">No agent has raised a hand.</p>}
          </div>
        </section>

        <section className="panel">
          <h2>Agent Notes</h2>
          <div className="scroll small">
            {messages.map((message) => (
              <MarkdownMessage key={message.id} message={message} />
            ))}
            {!messages.length && <p className="muted">Agent responses will appear here.</p>}
          </div>
        </section>

        <section className="panel creative">
          <h2>Generative UI</h2>
          <div className="scroll small">
            {messages.slice(0, 1).map((message) => (
              <MarkdownMessage key={`creative-${message.id}`} message={message} expanded />
            ))}
            {!messages.length && <p className="muted">Markdown, Mermaid diagrams, and interactive artifacts render here.</p>}
          </div>
        </section>

        <section className="panel">
          <h2>Work</h2>
          {tasks.length ? tasks.map((task) => <p key={task.id}>{task.title}: {task.status}</p>) : <p className="muted">No branch work has started.</p>}
        </section>
      </aside>
    </main>
  );
}

function MarkdownMessage({ message, expanded = false }: { message: AgentMessageEvent; expanded?: boolean }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let alive = true;
    markdownToHtml(message.text).then((value: string) => {
      if (alive) setHtml(value);
    });
    return () => { alive = false; };
  }, [message.text]);
  return (
    <article className={expanded ? "generated expanded" : "generated"}>
                <strong>{message.agentId}</strong>
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

function systemEvent(text: string): MeetingEvent {
  return {
    id: newEventId("sys"),
    type: "system",
    meetingId,
    createdAt: nowIso(),
    level: "info",
    text
  };
}

async function postEvent(event: MeetingEvent): Promise<void> {
  await fetch(`${api}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event)
  });
}

async function sendAudioChunk(blob: Blob): Promise<void> {
  const extension = blob.type.includes("mp4") ? "mp4" : "webm";
  await fetch(`${api}/audio/chunk?extension=${extension}&speaker=Host`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: await blob.arrayBuffer()
  }).catch((error) => console.warn("audio chunk failed", error));
}

function preferredMimeType(): string {
  for (const type of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

createRoot(document.getElementById("root")!).render(<App />);
