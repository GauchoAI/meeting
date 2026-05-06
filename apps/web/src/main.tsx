import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Mic, Phone, Play, Radio } from "lucide-react";
import { TranscriptBuffer } from "@meeting/transcript";
import type { AgentMessageEvent, MeetingEvent } from "@meeting/protocol";
// markdown2.html.js is intentionally a runtime JS translator file.
// @ts-expect-error TypeScript does not attach declarations to this dotted filename.
import { markdownToHtml } from "./markdown2.html.js";
import "./styles.css";

const api = import.meta.env.VITE_MEETING_API_URL || "http://localhost:4317";
const autoJoinKey = "meeting.autoJoin";
const query = new URLSearchParams(window.location.search);
const isEmbedded = query.get("embedded") === "1";
const appearanceKey = "meeting.appearance";

type Mode = "dark" | "light";
type Design = "material" | "codex" | "chatgpt" | "studio" | "terminal";
type Palette = "lime" | "blue" | "violet" | "amber" | "rose";
type FontSize = "small" | "medium" | "large" | "xlarge";

function App() {
  const transcript = useMemo(() => new TranscriptBuffer(), []);
  const [events, setEvents] = useState<MeetingEvent[]>([]);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const whisperActiveRef = useRef(false);
  const chunkTimeoutRef = useRef<number | null>(null);
  const autoJoinAttemptedRef = useRef(false);
  const [appearance, setAppearance] = useState(() => loadAppearance());

  useEffect(() => {
    let alive = true;
    let source: EventSource | undefined;

    void fetch(`${api}/events`)
      .then((response) => response.json() as Promise<{ events: MeetingEvent[] }>)
      .then((snapshot) => {
        if (!alive) return;
        setEvents([...snapshot.events].reverse().slice(0, 100));
        transcript.applyAll(snapshot.events);
        source = new EventSource(`${api}/events/stream`);
        source.addEventListener("meeting", (message) => {
          const event = JSON.parse((message as MessageEvent).data) as MeetingEvent;
          setEvents((current) => [event, ...current].slice(0, 100));
          transcript.apply(event);
        });
      })
      .catch((error) => console.warn("event stream failed", error));

    return () => {
      alive = false;
      source?.close();
    };
  }, [transcript]);

  useEffect(() => {
    document.documentElement.dataset.mode = appearance.mode;
    document.documentElement.dataset.design = appearance.design;
    document.documentElement.dataset.palette = appearance.palette;
    document.documentElement.dataset.fontSize = appearance.fontSize;
    localStorage.setItem(appearanceKey, JSON.stringify(appearance));
  }, [appearance]);

  useEffect(() => {
    if (isEmbedded || autoJoinAttemptedRef.current || sessionStorage.getItem(autoJoinKey) !== "true") return;
    autoJoinAttemptedRef.current = true;
    void joinMeeting().catch((error) => {
      sessionStorage.removeItem(autoJoinKey);
      console.warn("auto-join failed", error);
    });
  }, []);

  useEffect(() => {
    if (!isEmbedded) return;
    const send = (type: "meeting:push-to-talk:start" | "meeting:push-to-talk:stop") => {
      window.parent.postMessage({ type }, window.location.origin);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || isEditableElement(event.target)) return;
      event.preventDefault();
      send("meeting:push-to-talk:start");
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      send("meeting:push-to-talk:stop");
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const messages = events.filter((event): event is AgentMessageEvent => event.type === "agent.message");
  const canvasDocument = resolveCanvasDocument(query, messages);
  const latestMessage = messages[0];

  async function joinMeeting() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    sessionStorage.setItem(autoJoinKey, "true");
    setLocalStream(stream);
    setConnected(true);
    startWhisperCapture(stream);
  }

  function leaveMeeting() {
    sessionStorage.removeItem(autoJoinKey);
    stopWhisperCapture();
    localStream?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    setConnected(false);
  }

  function startWhisperCapture(sourceStream: MediaStream) {
    const audioTracks = sourceStream.getAudioTracks();
    if (!audioTracks.length) return;

    const audioOnlyStream = new MediaStream(audioTracks);
    whisperActiveRef.current = true;
    setRecording(true);
    recordWhisperChunk(audioOnlyStream);
  }

  function recordWhisperChunk(audioOnlyStream: MediaStream) {
    if (!whisperActiveRef.current) return;
    if (!audioOnlyStream.getAudioTracks().some((track) => track.readyState === "live")) {
      stopWhisperCapture();
      return;
    }

    const mimeType = preferredMimeType();
    const recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        void sendAudioChunk(blob);
      }
      if (whisperActiveRef.current) {
        chunkTimeoutRef.current = window.setTimeout(() => recordWhisperChunk(audioOnlyStream), 80);
      }
    };
    recorder.onerror = (event) => console.warn("Whisper recorder failed", event);
    recorder.start();
    recorderRef.current = recorder;
    chunkTimeoutRef.current = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, 3000);
  }

  function stopWhisperCapture() {
    whisperActiveRef.current = false;
    if (chunkTimeoutRef.current !== null) {
      window.clearTimeout(chunkTimeoutRef.current);
      chunkTimeoutRef.current = null;
    }
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    setRecording(false);
  }

  function pushToTalk(active: boolean) {
    if (!isEmbedded) return;
    window.parent.postMessage({ type: active ? "meeting:push-to-talk:start" : "meeting:push-to-talk:stop" }, window.location.origin);
  }

  return (
    <main className="shell">
      <section className="stage">
        <header className="topbar">
          <div>
            <h1>Meeting</h1>
            <p>P2P-ready room with transcript-driven local agents.</p>
          </div>
          <div className="topActions">
            <AppearanceControls appearance={appearance} onChange={setAppearance} />
            <div className="status"><Radio size={16} /> {isEmbedded ? "audio controlled by stable shell" : recording ? "local Whisper on" : connected ? "local media on" : "waiting for audio"}</div>
          </div>
        </header>

        <div className="canvas">
          {canvasDocument ? (
            <MarkdownDocument agentId={canvasDocument.agentId} text={canvasDocument.text} expanded />
          ) : latestMessage ? (
            <MarkdownDocument agentId={latestMessage.agentId} text={latestMessage.text} expanded />
          ) : (
            <div className="emptyCanvas">
              <h2>Agent canvas</h2>
              <p>Ask for Markdown, diagrams, grids, cards, plans, or generated UI.</p>
            </div>
          )}
        </div>

        <div className="controls">
          {isEmbedded ? (
            <button
              onPointerDown={() => pushToTalk(true)}
              onPointerUp={() => pushToTalk(false)}
              onPointerLeave={() => pushToTalk(false)}
              onPointerCancel={() => pushToTalk(false)}
            >
              <Mic size={16} /> Hold Space / hold here to speak
            </button>
          ) : !connected ? (
            <button onClick={joinMeeting}><Play size={16} /> Join meeting</button>
          ) : (
            <button onClick={leaveMeeting}><Phone size={16} /> Leave meeting</button>
          )}
        </div>
      </section>


    </main>
  );
}

function AppearanceControls({
  appearance,
  onChange
}: {
  appearance: { mode: Mode; design: Design; palette: Palette; fontSize: FontSize };
  onChange: React.Dispatch<React.SetStateAction<{ mode: Mode; design: Design; palette: Palette; fontSize: FontSize }>>;
}) {
  return (
    <div className="appearanceControls" aria-label="Appearance controls">
      <button
        className="modeToggle"
        onClick={() => onChange((current) => ({ ...current, mode: current.mode === "dark" ? "light" : "dark" }))}
        title="Toggle light/dark mode"
        aria-label="Toggle light/dark mode"
      >
        <span className="modeIcon sun">☀︎</span>
        <span className="modeTrack"><span className="modeThumb" /></span>
        <span className="modeIcon moon">☾</span>
      </button>
      <select
        value={appearance.design}
        onChange={(event) => onChange((current) => ({ ...current, design: event.target.value as Design }))}
        title="UX design language"
      >
        <option value="material">Material</option>
        <option value="codex">Codex</option>
        <option value="chatgpt">ChatGPT</option>
        <option value="studio">Studio</option>
        <option value="terminal">Terminal</option>
      </select>
      <div className="paletteSwatches" title="Color palette">
        {(["lime", "blue", "violet", "amber", "rose"] as Palette[]).map((palette) => (
          <button
            key={palette}
            className={`swatch swatch-${palette}${appearance.palette === palette ? " active" : ""}`}
            aria-label={`Use ${palette} palette`}
            aria-pressed={appearance.palette === palette}
            onClick={() => onChange((current) => ({ ...current, palette }))}
          />
        ))}
      </div>
      <div className="fontScaleMenu" title="Font size">
        {(["small", "medium", "large", "xlarge"] as FontSize[]).map((fontSize) => (
          <button
            key={fontSize}
            className={`fontChoice font-${fontSize}${appearance.fontSize === fontSize ? " active" : ""}`}
            aria-label={`Use ${fontSize} font size`}
            aria-pressed={appearance.fontSize === fontSize}
            onClick={() => onChange((current) => ({ ...current, fontSize }))}
          >
            Aa
          </button>
        ))}
      </div>
    </div>
  );
}

function loadAppearance(): { mode: Mode; design: Design; palette: Palette; fontSize: FontSize } {
  try {
    const parsed = JSON.parse(localStorage.getItem(appearanceKey) || "{}");
    const mode = query.get("mode") || parsed.mode;
    const design = query.get("design") || parsed.design;
    const palette = query.get("palette") || parsed.palette;
    const fontSize = query.get("fontSize") || query.get("size") || parsed.fontSize;
    return {
      mode: mode === "light" ? "light" : "dark",
      design: ["material", "codex", "chatgpt", "studio", "terminal"].includes(design) ? design : "codex",
      palette: ["lime", "blue", "violet", "amber", "rose"].includes(palette) ? palette : "lime",
      fontSize: ["small", "medium", "large", "xlarge"].includes(fontSize) ? fontSize : "medium"
    };
  } catch {
    return { mode: "dark", design: "codex", palette: "lime", fontSize: "medium" };
  }
}

function MarkdownDocument({ agentId, text, expanded = false }: { agentId: string; text: string; expanded?: boolean }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let alive = true;
    markdownToHtml(text).then((value: string) => {
      if (alive) setHtml(value);
    });
    return () => { alive = false; };
  }, [text]);
  return (
    <article className={expanded ? "generated expanded" : "generated"}>
      <strong>{agentId}</strong>
      <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

interface CanvasDocument {
  agentId: string;
  text: string;
}

const templates: Record<string, string> = {
  "routine-grid": `# {{title}}

<div class="md-grid cols-3">
{{#each items}}
<section class="md-card">
<h2>{{this.title}}</h2>
<p>{{this.text}}</p>
</section>
{{/each}}
</div>

> {{note}}`,
  "hero-cards": `# {{title}}

<p class="md-lede">{{subtitle}}</p>

<div class="md-grid cols-{{columns}}">
{{#each cards}}
<section class="md-card">
<h2>{{this.icon}} {{this.title}}</h2>
<p>{{this.body}}</p>
</section>
{{/each}}
</div>`,
  "mermaid-flow": `# {{title}}

\`\`\`mermaid
flowchart LR
{{#each steps}}
  {{this.id}}[{{this.label}}] --> {{this.next}}[{{this.nextLabel}}]
{{/each}}
\`\`\`

{{caption}}`
};

function resolveCanvasDocument(params: URLSearchParams, messages: AgentMessageEvent[]): CanvasDocument | undefined {
  const direct = params.get("md") || params.get("markdown");
  if (direct) return { agentId: "query-markdown", text: direct };

  const encoded = params.get("md64") || params.get("markdown64");
  if (encoded) return { agentId: "query-markdown", text: decodeBase64Url(encoded) };

  const templateName = params.get("template") || params.get("tpl");
  if (templateName) {
    const template = templates[templateName] || params.get("templateSource") || params.get("tplSource");
    if (template) return { agentId: `template:${templateName}`, text: renderTemplate(template, queryContext(params)) };
  }

  const id = params.get("id") || params.get("event");
  if (id) {
    const found = messages.find((message) => message.id === id || message.id.endsWith(id));
    if (found) return { agentId: found.agentId, text: found.text };
  }

  return undefined;
}

function queryContext(params: URLSearchParams): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) context[key] = coerceQueryValue(value);

  for (const key of ["data", "json"]) {
    const raw = params.get(key);
    if (raw) Object.assign(context, JSON.parse(raw) as Record<string, unknown>);
  }
  const data64 = params.get("data64") || params.get("json64");
  if (data64) Object.assign(context, JSON.parse(decodeBase64Url(data64)) as Record<string, unknown>);
  return context;
}

function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template
    .replace(/{{#each\s+([\w.]+)}}([\s\S]*?){{\/each}}/g, (_match, path: string, body: string) => {
      const value = getPath(context, path);
      if (!Array.isArray(value)) return "";
      return value.map((item, index) => renderTemplate(body, { ...context, this: item, index })).join("\n");
    })
    .replace(/{{\s*([\w.]+)\s*}}/g, (_match, path: string) => stringifyTemplateValue(getPath(context, path)));
}

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (key === "this" && value && typeof value === "object" && "this" in value) {
      return (value as Record<string, unknown>).this;
    }
    if (value && typeof value === "object" && key in value) return (value as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

function stringifyTemplateValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function coerceQueryValue(value: string): unknown {
  if (value.includes("|")) return value.split("|").map(coerceQueryValue);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
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

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || target.isContentEditable;
}

createRoot(document.getElementById("root")!).render(<App />);
