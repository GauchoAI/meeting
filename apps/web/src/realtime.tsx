import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./realtime.css";

const query = new URLSearchParams(window.location.search);
const requestedApi = query.get("api") || query.get("meetingApi");
if (requestedApi) localStorage.setItem("meeting.api", requestedApi);
const api = import.meta.env.VITE_MEETING_API_URL || requestedApi || localStorage.getItem("meeting.api") || `${window.location.protocol}//${window.location.hostname}:4317`;
const availableTools = [
  {
    name: "read_rendered_html",
    summary: "Reads the current live preview HTML file."
  },
  {
    name: "write_rendered_html",
    summary: "Publishes a new .meeting/realtime/index.html and reloads the preview."
  },
  {
    name: "run_shell_command",
    summary: "Runs short terminal commands in the allowed workspace."
  },
  {
    name: "run_codex_task",
    summary: "Invokes local Codex for repo inspection or code changes."
  }
] as const;

type LogTone = "info" | "tool" | "error";

interface LogEntry {
  id: string;
  tone: LogTone;
  title: string;
  body: string;
}

function App() {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const assistantDraftRef = useRef("");

  const [callState, setCallState] = useState<"idle" | "connecting" | "connected">("idle");
  const [agentText, setAgentText] = useState("");
  const [status, setStatus] = useState("Ready.");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [textPrompt, setTextPrompt] = useState("");
  const [previewNonce, setPreviewNonce] = useState(0);
  const previewUrl = useMemo(
    () => `${api}/realtime-artifacts/index.html?v=${previewNonce}`,
    [previewNonce]
  );

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  function appendLog(tone: LogTone, title: string, body: string) {
    setLogs((current) => [
      {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        tone,
        title,
        body
      },
      ...current
    ].slice(0, 30));
  }

  async function connect() {
    if (callState !== "idle") return;
    setCallState("connecting");
    setStatus("Opening local media and Realtime call...");
    assistantDraftRef.current = "";
    setAgentText("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const peer = new RTCPeerConnection();
      peerRef.current = peer;

      if (!remoteAudioRef.current) {
        remoteAudioRef.current = document.createElement("audio");
        remoteAudioRef.current.autoplay = true;
      }
      peer.ontrack = (event) => {
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = event.streams[0];
      };

      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) peer.addTrack(audioTrack, stream);

      const channel = peer.createDataChannel("oai-events");
      dataChannelRef.current = channel;
      channel.addEventListener("open", () => {
        setStatus("Connected. Speak naturally or send a text prompt.");
        appendLog("info", "Session", "Realtime data channel is open.");
        appendLog("info", "Available tools", availableTools.map((tool) => `${tool.name}: ${tool.summary}`).join("\n"));
      });
      channel.addEventListener("message", (event) => {
        void handleRealtimeEvent(event.data);
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const response = await fetch(`${api}/realtime/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: offer.sdp })
      });
      const answerSdp = await response.text();
      if (!response.ok) {
        throw new Error(answerSdp || `Realtime call failed with ${response.status}`);
      }

      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      setCallState("connected");
      setPreviewNonce((value) => value + 1);
    } catch (error) {
      appendLog("error", "Connect failed", error instanceof Error ? error.message : String(error));
      setStatus("Connection failed.");
      setCallState("idle");
      disconnect();
    }
  }

  function disconnect() {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setCallState("idle");
    setStatus("Disconnected.");
  }

  async function handleRealtimeEvent(raw: string) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      appendLog("error", "Invalid event", raw);
      return;
    }

    const type = String(event.type || "");
    if (type === "session.created" || type === "session.updated") {
      appendLog("info", type, shortJson(event));
      return;
    }
    if (type === "response.output_text.delta" || type === "response.output_audio_transcript.delta") {
      assistantDraftRef.current += String(event.delta || "");
      setAgentText(assistantDraftRef.current);
      return;
    }
    if (type === "response.output_text.done" || type === "response.output_audio_transcript.done") {
      if (assistantDraftRef.current.trim()) {
        appendLog("info", "Agent", assistantDraftRef.current.trim());
      }
      assistantDraftRef.current = "";
      return;
    }
    if (type === "response.function_call_arguments.done") {
      const name = String(event.name || "");
      const argsText = String(event.arguments || "{}");
      const callId = String(event.call_id || "");
      appendLog("tool", `Tool requested: ${name}`, argsText);
      let parsedArgs: unknown = {};
      try {
        parsedArgs = JSON.parse(argsText);
      } catch {
        parsedArgs = { raw: argsText };
      }
      const toolResponse = await fetch(`${api}/realtime/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, arguments: parsedArgs })
      }).then((res) => res.json() as Promise<Record<string, unknown>>);

      if (name === "write_rendered_html" && toolResponse.ok) {
        setPreviewNonce((value) => value + 1);
      }
      appendLog(toolResponse.ok ? "tool" : "error", `Tool result: ${name}`, shortJson(toolResponse));
      sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(toolResponse)
        }
      });
      sendRealtimeEvent({ type: "response.create" });
      return;
    }
    if (type === "error") {
      appendLog("error", "Realtime error", shortJson(event));
      return;
    }
    if (type === "response.done") {
      setStatus("Connected. Speak or ask for another change.");
      return;
    }
  }

  function sendRealtimeEvent(event: unknown) {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify(event));
  }

  function submitTextPrompt() {
    const text = textPrompt.trim();
    if (!text) return;
    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }]
      }
    });
    sendRealtimeEvent({ type: "response.create" });
    appendLog("info", "You", text);
    setTextPrompt("");
  }

  return (
    <main className="realtimeShell">
      <section className="hero">
        <div>
          <span className="eyebrow">Meeting x Realtime x Codex</span>
          <h1>Voice call with a coding agent that can rewrite live HTML on screen.</h1>
          <p>
            This demo opens a WebRTC session to <code>gpt-realtime-2</code>, exposes local tools for shell and Codex work, and renders the agent&apos;s <code>index.html</code> output in the preview pane.
          </p>
        </div>
        <div className="heroActions">
          {callState === "idle" ? (
            <button className="primary" onClick={() => void connect()}>Connect Call</button>
          ) : (
            <button className="danger" onClick={disconnect}>{callState === "connecting" ? "Cancel" : "Hang Up"}</button>
          )}
          <span className={`statusPill status-${callState}`}>{status}</span>
        </div>
      </section>

      <section className="dashboard">
        <div className="stack">
          <article className="panel videoPanel">
            <div className="panelHeader">
              <strong>Local camera</strong>
              <span>Only audio is sent to the model. Video is local UI only.</span>
            </div>
            <video ref={localVideoRef} autoPlay playsInline muted />
          </article>

          <article className="panel promptPanel">
            <div className="panelHeader">
              <strong>Prompt fallback</strong>
              <span>Use text if you want to steer the agent precisely.</span>
            </div>
            <div className="promptComposer">
              <textarea
                value={textPrompt}
                onChange={(event) => setTextPrompt(event.target.value)}
                placeholder="Ask the agent to inspect the repo, design a UI, or contribute this idea to meeting."
              />
              <button className="primary" onClick={submitTextPrompt} disabled={callState !== "connected"}>Send</button>
            </div>
          </article>

          <article className="panel toolPanel">
            <div className="panelHeader">
              <strong>Exposed tools</strong>
              <span>These are registered in the Realtime session.</span>
            </div>
            <div className="toolList">
              {availableTools.map((tool) => (
                <div key={tool.name} className="toolCard">
                  <strong>{tool.name}</strong>
                  <p>{tool.summary}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="panel transcriptPanel">
            <div className="panelHeader">
              <strong>Agent transcript</strong>
              <span>Realtime text and tool activity.</span>
            </div>
            <div className="transcriptBody">
              <div className="agentBubble">{agentText || "Waiting for agent output..."}</div>
              <div className="logList">
                {logs.map((entry) => (
                  <div key={entry.id} className={`logCard log-${entry.tone}`}>
                    <strong>{entry.title}</strong>
                    <pre>{entry.body}</pre>
                  </div>
                ))}
              </div>
            </div>
          </article>
        </div>

        <article className="panel previewPanel">
          <div className="panelHeader">
            <strong>Rendered index.html</strong>
            <span>Reloads when the agent writes the preview artifact.</span>
          </div>
          <iframe title="Realtime agent preview" src={previewUrl} />
        </article>
      </section>
    </main>
  );
}

function shortJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return text.length > 3000 ? `${text.slice(0, 3000)}\n...truncated...` : text;
}

createRoot(document.getElementById("root")!).render(<App />);
