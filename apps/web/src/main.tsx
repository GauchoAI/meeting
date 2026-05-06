import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Mic, Phone, Play, Radio } from "lucide-react";
import "@excalidraw/excalidraw/index.css";
import { TranscriptBuffer } from "@meeting/transcript";
import type { AgentMessageEvent, MeetingEvent } from "@meeting/protocol";
import { layoutWithLines, prepareWithSegments, measureLineStats } from "@chenglou/pretext";
import { RoughGenerator } from "roughjs/bin/generator";
// markdown2.html.js is intentionally a runtime JS translator file.
// @ts-expect-error TypeScript does not attach declarations to this dotted filename.
import { markdownToHtml } from "./markdown2.html.js";
import "./styles.css";

const api = import.meta.env.VITE_MEETING_API_URL || "http://localhost:4317";
const autoJoinKey = "meeting.autoJoin";
const query = new URLSearchParams(window.location.search);
const isEmbedded = query.get("embedded") === "1";
const appearanceKey = "meeting.appearance";
const normalizeExcalidraw = false;
const useNativeDiagramRenderer = true;
const roughGenerator = new RoughGenerator({ options: { roughness: 1.15, bowing: 1.8, curveFitting: 0.95 } });
const LazyExcalidraw = React.lazy(async () => {
  const module = await import("@excalidraw/excalidraw");
  return { default: module.Excalidraw };
});

type Mode = "dark" | "light";
type Design = "material" | "codex" | "chatgpt" | "studio" | "terminal";
type Palette = "lime" | "blue" | "violet" | "amber" | "rose";
type FontSize = "small" | "medium" | "large" | "xlarge";

interface RenderSample {
  markdownMs: number;
  eventToRenderMs?: number;
  at: number;
}

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [renderSamples, setRenderSamples] = useState<RenderSample[]>([]);
  const recordRenderSample = useCallback((sample: RenderSample) => {
    setRenderSamples((current) => [...current.slice(-49), sample]);
  }, []);

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
          setEvents((current) => upsertEvent(current, event).slice(0, 100));
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
  const renderStats = summarizeRenderSamples(renderSamples);
  const terminalLines = [formatRenderStats(renderStats), ...events.slice(0, 80).reverse().map(formatTerminalEvent)];

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
      <div className="floatingButtons" aria-label="Meeting controls">
        <button className={menuOpen ? "active" : ""} onClick={() => setMenuOpen((value) => !value)}>Menu</button>
        <button className={terminalOpen ? "active" : ""} onClick={() => setTerminalOpen((value) => !value)}>Raw</button>
      </div>

      {menuOpen && (
        <aside className="floatingPanel menuPanel">
          <div className="drawerHeader">
            <strong>Controls</strong>
            <button className="secondary" onClick={() => setMenuOpen(false)}>Close</button>
          </div>
          <AppearanceControls appearance={appearance} onChange={setAppearance} />
          <div className="status"><Radio size={16} /> {isEmbedded ? "audio controlled by stable shell" : recording ? "local Whisper on" : connected ? "local media on" : "waiting for audio"}</div>
          {!isEmbedded && (!connected ? (
            <button onClick={joinMeeting}><Play size={16} /> Join meeting</button>
          ) : (
            <button onClick={leaveMeeting}><Phone size={16} /> Leave meeting</button>
          ))}
        </aside>
      )}

      {terminalOpen && (
        <aside className="floatingPanel terminalPanel">
          <div className="terminalToolbar">
            <strong>Raw terminal</strong>
            <button className="secondary" onClick={() => setTerminalOpen(false)}>Close</button>
          </div>
          <pre className="terminalOutput">{terminalLines.join("\n\n") || "waiting for meeting events..."}</pre>
        </aside>
      )}

      <section className="stage">
        <div className="canvas">
          {canvasDocument ? (
            <MarkdownDocument
              agentId={canvasDocument.agentId}
              text={canvasDocument.text}
              createdAt={canvasDocument.createdAt}
              expanded
              onRender={recordRenderSample}
            />
          ) : latestMessage ? (
            <MarkdownDocument
              agentId={latestMessage.agentId}
              text={latestMessage.text}
              createdAt={latestMessage.createdAt}
              expanded
              onRender={recordRenderSample}
            />
          ) : (
            <div className="emptyCanvas">
              <h2>Agent canvas</h2>
              <p>Ask for Markdown, diagrams, grids, cards, plans, or generated UI.</p>
            </div>
          )}
        </div>
      </section>

      {isEmbedded && (
        <button
          className="floatingTalk"
          onPointerDown={() => pushToTalk(true)}
          onPointerUp={() => pushToTalk(false)}
          onPointerLeave={() => pushToTalk(false)}
          onPointerCancel={() => pushToTalk(false)}
        >
          <Mic size={16} /> Hold to speak
        </button>
      )}
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

function MarkdownDocument({
  agentId,
  text,
  createdAt,
  expanded = false,
  onRender
}: {
  agentId: string;
  text: string;
  createdAt?: string;
  expanded?: boolean;
  onRender?: (sample: RenderSample) => void;
}) {
  const parts = useMemo(() => splitExcalidrawBlocks(text), [text]);
  return (
    <article className={expanded ? "generated expanded" : "generated"}>
      <strong>{agentId}</strong>
      {parts.map((part, index) => part.kind === "excalidraw" ? (
        <ExcalidrawScene key={`${index}-excalidraw`} source={part.source} />
      ) : (
        <MarkdownHtml
          key={`${index}-markdown`}
          text={part.source}
          createdAt={createdAt}
          onRender={index === 0 ? onRender : undefined}
        />
      ))}
    </article>
  );
}

function MarkdownHtml({ text, createdAt, onRender }: { text: string; createdAt?: string; onRender?: (sample: RenderSample) => void }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let alive = true;
    const started = performance.now();
    markdownToHtml(text).then((value: string) => {
      if (!alive) return;
      const markdownMs = performance.now() - started;
      setHtml(value);
      onRender?.({
        markdownMs,
        eventToRenderMs: createdAt ? Date.now() - Date.parse(createdAt) : undefined,
        at: Date.now()
      });
    });
    return () => { alive = false; };
  }, [text, createdAt, onRender]);
  if (!text.trim()) return null;
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ExcalidrawScene({ source }: { source: string }) {
  if (useNativeDiagramRenderer) return <NativeDiagram source={source} />;

  const [parsed, setParsed] = useState<{ ok: true; data: Record<string, unknown>; height: number } | { ok: false; error: string } | undefined>();
  useEffect(() => {
    let alive = true;
    parseExcalidrawSource(source).then((result) => {
      if (alive) setParsed(result);
    });
    return () => { alive = false; };
  }, [source]);
  if (!parsed) return <div className="excalidrawLoading">Preparing Excalidraw scene…</div>;
  if (!parsed.ok) return <pre className="diagram-error">Invalid Excalidraw block\n\n{parsed.error}</pre>;
  return (
    <div className="excalidrawEmbed" style={{ height: parsed.height }}>
      <React.Suspense fallback={<div className="excalidrawLoading">Loading Excalidraw…</div>}>
        <LazyExcalidraw
          initialData={parsed.data}
          viewModeEnabled
          zenModeEnabled
          gridModeEnabled={false}
          theme={document.documentElement.dataset.mode === "light" ? "light" : "dark"}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveAsImage: false,
              saveToActiveFile: false,
              toggleTheme: false
            }
          }}
        />
      </React.Suspense>
    </div>
  );
}

function NativeDiagram({ source }: { source: string }) {
  const parsed = useMemo(() => parseNativeDiagram(source), [source]);
  if (!parsed.ok) return <pre className="diagram-error">Invalid native diagram\n\n{parsed.error}</pre>;
  return <NativeDiagramSvg scene={parsed.scene} />;
}

type DiagramElement = Record<string, unknown>;
type DiagramScene = { elements: DiagramElement[] };
type MeasuredDiagramElement = DiagramElement & { measuredLabel?: { lines: string[]; fontSize: number; lineHeight: number; width: number; height: number } };

type RenderPart = { kind: "markdown" | "excalidraw"; source: string };

function splitExcalidrawBlocks(text: string): RenderPart[] {
  const parts: RenderPart[] = [];
  const pattern = /```(?:excalidraw|excalidraw-json|excalidraw\.json|diagram|native-diagram)\s*\n([\s\S]*?)(?:```|$)/gi;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) parts.push({ kind: "markdown", source: text.slice(lastIndex, match.index) });
    parts.push({ kind: "excalidraw", source: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ kind: "markdown", source: text.slice(lastIndex) });
  return parts.length ? parts : [{ kind: "markdown", source: text }];
}

function parseNativeDiagram(source: string): { ok: true; scene: DiagramScene } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(source) as unknown;
    const scene = Array.isArray(parsed) ? { elements: parsed } : parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    if (!scene || !Array.isArray(scene.elements)) return { ok: false, error: "Expected a JSON object with an elements array." };
    return { ok: true, scene: { elements: scene.elements.filter((element): element is DiagramElement => Boolean(element) && typeof element === "object") } };
  } catch {
    try {
      return { ok: true, scene: parseConciseDiagram(source) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function parseConciseDiagram(source: string): DiagramScene {
  const lines = source.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const elements: DiagramElement[] = [];
  const labels = new Map<number, string>();
  const shapes = new Map<number, string>();
  const styles = new Map<number, Record<string, string>>();
  const edges: Array<{ from: number; to: number; label?: string; arrowhead?: string; style?: Record<string, string> }> = [];
  let count = 0;
  let section: "edges" | "labels" | "shapes" | "styles" | undefined;

  for (const line of lines) {
    const nodesMatch = line.match(/^nodes\s*:\s*(\d+)$/i);
    if (nodesMatch) { count = Number(nodesMatch[1]); section = undefined; continue; }
    const sectionMatch = line.match(/^(edges|labels|shapes|styles)\s*:\s*$/i);
    if (sectionMatch) { section = sectionMatch[1].toLowerCase() as typeof section; continue; }

    const edgeText = line.replace(/^[-*]\s*/, "");
    const edgeMatch = edgeText.match(/^(\d+)\s*->\s*(\d+)(?:\s+[\"“]([^\"”]*)[\"”]?)?(?:\s+(none|arrow|triangle|dot|bar))?(?:\s+(.*))?$/);
    if (section === "edges" && edgeMatch) {
      edges.push({ from: Number(edgeMatch[1]), to: Number(edgeMatch[2]), label: edgeMatch[3], arrowhead: edgeMatch[4], style: parseInlineStyle(edgeMatch[5] || "") });
      count = Math.max(count, Number(edgeMatch[1]) + 1, Number(edgeMatch[2]) + 1);
      continue;
    }

    const valueMatch = parseProgressiveKeyValue(edgeText);
    if (valueMatch && section === "labels") { labels.set(valueMatch.index, valueMatch.value); continue; }
    if (valueMatch && section === "shapes") { shapes.set(valueMatch.index, valueMatch.value.trim() || "rectangle"); continue; }
    if (valueMatch && section === "styles") { styles.set(valueMatch.index, parseInlineStyle(valueMatch.value)); continue; }
  }

  if (!count) count = Math.max(...Array.from(labels.keys()), ...Array.from(shapes.keys()), -1) + 1;
  if (!count) throw new Error("Concise diagram requires `nodes: <count>` or at least one edge/label.");
  const positions = layoutConciseNodes(count, edges);
  for (let index = 0; index < count; index++) {
    const position = positions[index];
    elements.push({
      type: shapes.get(index) || "rectangle",
      x: position.x,
      y: position.y,
      width: 190,
      height: 80,
      strokeColor: styles.get(index)?.stroke || "#94a3b8",
      backgroundColor: styles.get(index)?.fill || "transparent",
      fillStyle: styles.get(index)?.fillStyle,
      strokeStyle: styles.get(index)?.strokeStyle,
      strokeWidth: styles.get(index)?.strokeWidth ? Number(styles.get(index)?.strokeWidth) : undefined,
      roughness: styles.get(index)?.roughness ? Number(styles.get(index)?.roughness) : undefined,
      opacity: styles.get(index)?.opacity ? Number(styles.get(index)?.opacity) : undefined,
      textAlign: styles.get(index)?.textAlign,
      label: { text: labels.get(index) || `Node ${index}`, fontSize: styles.get(index)?.fontSize ? Number(styles.get(index)?.fontSize) : 22 }
    });
  }
  for (const edge of edges) {
    const from = positions[edge.from];
    const to = positions[edge.to];
    elements.push({
      type: "arrow",
      x: from.x + 95,
      y: from.y + 40,
      width: to.x + 95 - (from.x + 95),
      height: to.y + 40 - (from.y + 40),
      strokeColor: edge.style?.stroke || "#64748b",
      strokeStyle: edge.style?.strokeStyle,
      strokeWidth: edge.style?.strokeWidth ? Number(edge.style.strokeWidth) : undefined,
      roughness: edge.style?.roughness ? Number(edge.style.roughness) : undefined,
      opacity: edge.style?.opacity ? Number(edge.style.opacity) : undefined,
      fromIndex: edge.from,
      toIndex: edge.to,
      endArrowhead: edge.arrowhead === "none" ? undefined : edge.arrowhead || edge.style?.arrowhead || "arrow",
      label: edge.label ? { text: edge.label, fontSize: edge.style?.fontSize ? Number(edge.style.fontSize) : 16 } : undefined
    });
  }
  return { elements };
}

function parseInlineStyle(value: string): Record<string, string> {
  const style: Record<string, string> = {};
  for (const part of value.split(/[,;]\s*|\s+/).filter(Boolean)) {
    const [key, raw] = part.split("=");
    if (key && raw) style[key.trim()] = raw.trim();
  }
  return style;
}

function parseProgressiveKeyValue(line: string): { index: number; value: string } | undefined {
  const match = line.match(/^(\d+)\s*:\s*(.*)$/);
  if (!match) return undefined;
  let value = match[2].trim();
  if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("“") && !value.endsWith("”"))) {
    value = value.slice(1);
  } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("“") && value.endsWith("”"))) {
    value = value.slice(1, -1);
  }
  return { index: Number(match[1]), value };
}

function layoutConciseNodes(count: number, _edges: Array<{ from: number; to: number }>): Array<{ x: number; y: number }> {
  // Progressive concise diagrams must stay stable while text and edges stream in.
  // A bounded grid avoids runaway sizing from cycles/back-edges such as decision loops.
  const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))));
  return Array.from({ length: count }, (_, index) => ({
    x: 80 + (index % columns) * 360,
    y: 80 + Math.floor(index / columns) * 230
  }));
}

function NativeDiagramSvg({ scene }: { scene: DiagramScene }) {
  const measured = useMemo(() => syncIndexedConnectors(applyDiagramMargins(measureDiagramElements(scene.elements))), [scene]);
  const bounds = diagramBounds(measured);
  const viewBox = `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`;
  return (
    <div className="nativeDiagramEmbed">
      <svg viewBox={viewBox} role="img" aria-label="Generated diagram">
        <defs>
          <marker id="native-arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {measured.map((element, index) => ({ element, index }))
          .filter(({ element }) => isConnectorElement(element))
          .map(({ element, index }) => renderNativeElement(element, index, measured))}
        {measured.map((element, index) => ({ element, index }))
          .filter(({ element }) => !isConnectorElement(element))
          .map(({ element, index }) => renderNativeElement(element, index, measured))}
      </svg>
    </div>
  );
}

function measureDiagramElements(elements: DiagramElement[]): MeasuredDiagramElement[] {
  return elements.map((element) => {
    const item: MeasuredDiagramElement = { ...element };
    const label = normalizeLabel(item.label, item.text);
    if (label && item.type !== "arrow" && item.type !== "line" && item.type !== "text") {
      const fontSize = Math.min(typeof label.fontSize === "number" ? label.fontSize : 22, 22);
      const maxTextWidth = Math.max(numberOr(item.width, 0) - 44, 180);
      const measured = layoutLabel(label.text, fontSize, maxTextWidth);
      item.width = Math.max(numberOr(item.width, 0), Math.ceil(measured.width + 56));
      item.height = Math.max(numberOr(item.height, 0), Math.ceil(measured.height + 40));
      item.measuredLabel = measured;
    }
    return item;
  });
}

function applyDiagramMargins(elements: MeasuredDiagramElement[], minGap = 72): MeasuredDiagramElement[] {
  const adjusted = elements.map((element) => ({ ...element }));
  const shapes = adjusted.filter((element) => !isConnectorElement(element));
  for (let pass = 0; pass < 4; pass++) {
    for (const upper of shapes) {
      for (const lower of shapes) {
        if (upper === lower) continue;
        const ux = numberOr(upper.x, 0);
        const uy = numberOr(upper.y, 0);
        const uw = numberOr(upper.width, 0);
        const uh = numberOr(upper.height, 0);
        const lx = numberOr(lower.x, 0);
        const ly = numberOr(lower.y, 0);
        const lw = numberOr(lower.width, 0);
        const horizontalOverlap = ux < lx + lw && lx < ux + uw;
        if (!horizontalOverlap || ly < uy) continue;
        const gap = ly - (uy + uh);
        if (gap < minGap) lower.y = ly + (minGap - gap);
      }
    }
  }
  return adjusted;
}

function syncIndexedConnectors(elements: MeasuredDiagramElement[]): MeasuredDiagramElement[] {
  const adjusted = elements.map((element) => ({ ...element }));
  for (const connector of adjusted.filter(isConnectorElement)) {
    if (typeof connector.fromIndex !== "number" || typeof connector.toIndex !== "number") continue;
    const from = adjusted[connector.fromIndex];
    const to = adjusted[connector.toIndex];
    if (!from || !to) continue;
    const x1 = numberOr(from.x, 0) + numberOr(from.width, 0) / 2;
    const y1 = numberOr(from.y, 0) + numberOr(from.height, 0) / 2;
    const x2 = numberOr(to.x, 0) + numberOr(to.width, 0) / 2;
    const y2 = numberOr(to.y, 0) + numberOr(to.height, 0) / 2;
    connector.x = x1;
    connector.y = y1;
    connector.width = x2 - x1;
    connector.height = y2 - y1;
  }
  return adjusted;
}

function layoutLabel(text: string, fontSize: number, maxWidth: number) {
  const lineHeight = fontSize * 1.25;
  try {
    const prepared = prepareWithSegments(text, `${fontSize}px Virgil, ui-sans-serif, system-ui`, { whiteSpace: "normal" });
    const { lines } = layoutWithLines(prepared, maxWidth, lineHeight);
    return {
      lines: lines.map((line) => line.text),
      fontSize,
      lineHeight,
      width: Math.max(...lines.map((line) => line.width), 0),
      height: lines.length * lineHeight
    };
  } catch {
    const wrapped = wrapLabel(text, fontSize, maxWidth);
    const lines = wrapped.split("\n");
    return { lines, fontSize, lineHeight, width: Math.max(...lines.map((line) => estimateTextWidth(line, fontSize)), 0), height: lines.length * lineHeight };
  }
}

function isConnectorElement(element: DiagramElement): boolean {
  const type = String(element.type || "");
  return type === "arrow" || type === "line";
}

function renderNativeElement(element: MeasuredDiagramElement, index: number, elements: MeasuredDiagramElement[]) {
  const type = String(element.type || "rectangle");
  if (isConnectorElement(element)) return renderNativeArrow(element, index, elements);
  if (type === "text") return renderNativeText(element, index);
  return renderNativeShape(element, index, type);
}

function renderNativeShape(element: MeasuredDiagramElement, index: number, type: string) {
  const x = numberOr(element.x, 0);
  const y = numberOr(element.y, 0);
  const width = Math.max(1, numberOr(element.width, 160));
  const height = Math.max(1, numberOr(element.height, 80));
  const stroke = typeof element.strokeColor === "string" ? element.strokeColor : "currentColor";
  const fill = typeof element.backgroundColor === "string" && element.backgroundColor !== "transparent" ? element.backgroundColor : "var(--canvas)";
  const hachureColor = adjustColorForHachure(fill, stroke);
  const opacity = typeof element.opacity === "number" ? element.opacity : undefined;
  return (
    <g key={index} opacity={opacity}>
      {renderRoughShape(type, x, y, width, height, stroke, fill, hachureColor, index, element)}
      {element.measuredLabel && renderLabel(element.measuredLabel, x + width / 2, y + height / 2, index)}
    </g>
  );
}

function roundedRectPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return `M ${x + r} ${y} L ${x + width - r} ${y} Q ${x + width} ${y} ${x + width} ${y + r} L ${x + width} ${y + height - r} Q ${x + width} ${y + height} ${x + width - r} ${y + height} L ${x + r} ${y + height} Q ${x} ${y + height} ${x} ${y + height - r} L ${x} ${y + r} Q ${x} ${y} ${x + r} ${y} Z`;
}

function renderRoughShape(type: string, x: number, y: number, width: number, height: number, stroke: string, fill: string, hachureColor: string, seed: number, element: MeasuredDiagramElement) {
  const options = {
    stroke,
    fill,
    fillStyle: typeof element.fillStyle === "string" ? element.fillStyle : fill === "var(--canvas)" ? "solid" : "hachure",
    fillWeight: 1.1,
    hachureGap: 8,
    hachureAngle: -45,
    hachureColor,
    strokeWidth: typeof element.strokeWidth === "number" ? element.strokeWidth : 2.1,
    seed: seed + 1,
    roughness: typeof element.roughness === "number" ? element.roughness : 1.35,
    bowing: 1.8,
    strokeLineDash: element.strokeStyle === "dashed" ? [12, 8] : element.strokeStyle === "dotted" ? [2, 8] : undefined
  };
  const drawable = type === "ellipse"
    ? roughGenerator.ellipse(x + width / 2, y + height / 2, width, height, options)
    : type === "diamond"
      ? roughGenerator.polygon([[x + width / 2, y], [x + width, y + height / 2], [x + width / 2, y + height], [x, y + height / 2]], options)
      : roughGenerator.path(roundedRectPath(x, y, width, height, Math.min(24, width / 8, height / 3)), options);
  return <g className="nativeSketch">{roughGenerator.toPaths(drawable).map((path, pathIndex) => <path key={pathIndex} d={path.d} stroke={path.stroke} strokeWidth={path.strokeWidth} fill={path.fill || "none"} opacity={path.fill && path.stroke === hachureColor ? 0.24 : undefined} />)}</g>;
}

function adjustColorForHachure(fill: string, stroke: string): string {
  if (fill === "var(--canvas)" || fill === "transparent") return stroke;
  const rgb = parseHexColor(fill);
  if (!rgb) return stroke;
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  if (luminance > 0.62) return mixHex(fill, "#ffffff", 0.82);
  if (luminance < 0.28) return mixHex(fill, "#ffffff", 0.68);
  return mixHex(fill, "#ffffff", 0.74);
}

function parseHexColor(color: string): { r: number; g: number; b: number } | undefined {
  const normalized = color.trim();
  const match = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return undefined;
  const hex = match[1].length === 3 ? match[1].split("").map((char) => char + char).join("") : match[1];
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
}

function mixHex(a: string, b: string, amount: number): string {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (!ca || !cb) return b;
  const mix = (from: number, to: number) => Math.round(from + (to - from) * amount).toString(16).padStart(2, "0");
  return `#${mix(ca.r, cb.r)}${mix(ca.g, cb.g)}${mix(ca.b, cb.b)}`;
}

function renderLabel(label: NonNullable<MeasuredDiagramElement["measuredLabel"]>, cx: number, cy: number, key: number) {
  const startY = cy - label.height / 2 + label.fontSize;
  return (
    <text key={`label-${key}`} className="nativeLabel" x={cx} y={startY} fontSize={label.fontSize} textAnchor="middle">
      {label.lines.map((line, lineIndex) => <tspan key={lineIndex} x={cx} dy={lineIndex ? label.lineHeight : 0}>{line}</tspan>)}
    </text>
  );
}

function renderNativeText(element: MeasuredDiagramElement, index: number) {
  const text = String(element.text || "");
  const fontSize = numberOr(element.fontSize, 22);
  return <text key={index} className="nativeLabel" x={numberOr(element.x, 0)} y={numberOr(element.y, 0) + fontSize} fontSize={fontSize}>{text}</text>;
}

function renderNativeArrow(element: MeasuredDiagramElement, index: number, elements: MeasuredDiagramElement[]) {
  const rawX1 = numberOr(element.x, 0);
  const rawY1 = numberOr(element.y, 0);
  const rawX2 = rawX1 + numberOr(element.width, 0);
  const rawY2 = rawY1 + numberOr(element.height, 0);
  const stroke = typeof element.strokeColor === "string" ? element.strokeColor : "currentColor";
  const label = normalizeLabel(element.label, undefined);
  const route = typeof element.fromIndex === "number" && element.fromIndex === element.toIndex
    ? routeSelfConnector(elements[element.fromIndex])
    : (() => {
      const trimmed = trimConnectorToShapes(rawX1, rawY1, rawX2, rawY2, elements);
      return routeConnector(trimmed.x1, trimmed.y1, trimmed.x2, trimmed.y2, rawX1, rawY1, rawX2, rawY2, elements, typeof element.fromIndex === "number" ? element.fromIndex : undefined, typeof element.toIndex === "number" ? element.toIndex : undefined);
    })();
  const headFrom = route.points[Math.max(0, route.points.length - 2)];
  const headTo = route.points[route.points.length - 1];
  const routeLabel = label ? placeRouteLabel(route, label, elements) : route.label;
  return (
    <g key={index} className="nativeArrow" style={{ color: stroke }} opacity={typeof element.opacity === "number" ? element.opacity : undefined}>
      {renderRoughRoute(route, stroke, index, element)}
      {element.endArrowhead && headFrom && headTo ? renderNativeArrowhead(headFrom.x, headFrom.y, headTo.x, headTo.y, stroke, index, String(element.endArrowhead)) : null}
      {label ? (
        <g>
          <rect className="nativeArrowLabelBg" x={routeLabel.x - estimateTextWidth(label.text, label.fontSize || 16) / 2 - 8} y={routeLabel.y - (label.fontSize || 16)} width={estimateTextWidth(label.text, label.fontSize || 16) + 16} height={(label.fontSize || 16) + 8} rx={8} />
          <text className="nativeArrowLabel" x={routeLabel.x} y={routeLabel.y} textAnchor="middle" fontSize={label.fontSize || 16}>{label.text}</text>
        </g>
      ) : null}
    </g>
  );
}

function trimConnectorToShapes(x1: number, y1: number, x2: number, y2: number, elements: MeasuredDiagramElement[]) {
  const shapes = elements.filter((shape) => !isConnectorElement(shape)).map(toShapeBounds);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const farX = x1 + ux * 10_000;
  const farY = y1 + uy * 10_000;
  let start = { x: x1, y: y1 };
  let end = { x: x2, y: y2 };
  let startShape: ShapeBounds | undefined;

  for (const shape of shapes) {
    if (pointInRect(start.x, start.y, shape)) {
      startShape = shape;
      start = intersectShapeRay(shape, start.x, start.y, farX, farY) || start;
    }
  }

  const endShape = shapes.find((shape) => pointInRect(end.x, end.y, shape));
  if (endShape) {
    end = intersectShapeRay(endShape, end.x, end.y, x1, y1) || end;
  } else {
    const nextHit = shapes
      .filter((shape) => shape !== startShape)
      .map((shape) => intersectShapeRayWithT(shape, start.x, start.y, farX, farY))
      .filter((hit): hit is { t: number; x: number; y: number } => hit !== undefined && hit.t > 0.001)
      .sort((a, b) => a.t - b.t)[0];
    if (nextHit) end = { x: nextHit.x, y: nextHit.y };
  }

  // Keep rough strokes and arrowheads outside filled shapes. This avoids the
  // visual bug where a correctly trimmed connector is later covered by the
  // target box or appears to run inside a diamond/ellipse.
  const startGap = 10;
  const endGap = 18;
  start = { x: start.x + ux * startGap, y: start.y + uy * startGap };
  end = { x: end.x - ux * endGap, y: end.y - uy * endGap };
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}

type ShapeBounds = { type: string; x: number; y: number; width: number; height: number };

function toShapeBounds(shape: MeasuredDiagramElement): ShapeBounds {
  return {
    type: String(shape.type || "rectangle"),
    x: numberOr(shape.x, 0),
    y: numberOr(shape.y, 0),
    width: numberOr(shape.width, 0),
    height: numberOr(shape.height, 0)
  };
}

function pointInRect(x: number, y: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function intersectShapeRay(shape: ShapeBounds, x1: number, y1: number, x2: number, y2: number): { x: number; y: number } | undefined {
  const hit = intersectShapeRayWithT(shape, x1, y1, x2, y2);
  return hit ? { x: hit.x, y: hit.y } : undefined;
}

function intersectShapeRayWithT(shape: ShapeBounds, x1: number, y1: number, x2: number, y2: number): { t: number; x: number; y: number } | undefined {
  if (shape.type === "diamond") return intersectPolygonRayWithT(diamondPoints(shape), x1, y1, x2, y2);
  if (shape.type === "ellipse") return intersectEllipseRayWithT(shape, x1, y1, x2, y2);
  return intersectRectRayWithT(shape, x1, y1, x2, y2);
}

function intersectRectRayWithT(rect: { x: number; y: number; width: number; height: number }, x1: number, y1: number, x2: number, y2: number): { t: number; x: number; y: number } | undefined {
  return intersectPolygonRayWithT([[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]], x1, y1, x2, y2);
}

function diamondPoints(shape: ShapeBounds): Array<[number, number]> {
  return [[shape.x + shape.width / 2, shape.y], [shape.x + shape.width, shape.y + shape.height / 2], [shape.x + shape.width / 2, shape.y + shape.height], [shape.x, shape.y + shape.height / 2]];
}

function intersectPolygonRayWithT(points: Array<[number, number]>, x1: number, y1: number, x2: number, y2: number): { t: number; x: number; y: number } | undefined {
  const candidates: Array<{ t: number; x: number; y: number }> = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const hit = intersectSegments(x1, y1, x2, y2, a[0], a[1], b[0], b[1]);
    if (hit && hit.t > 0) candidates.push(hit);
  }
  candidates.sort((a, b) => a.t - b.t);
  return candidates[0];
}

function intersectSegments(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, x4: number, y4: number): { t: number; x: number; y: number } | undefined {
  const rX = x2 - x1;
  const rY = y2 - y1;
  const sX = x4 - x3;
  const sY = y4 - y3;
  const denominator = rX * sY - rY * sX;
  if (Math.abs(denominator) < 0.0001) return undefined;
  const qpx = x3 - x1;
  const qpy = y3 - y1;
  const t = (qpx * sY - qpy * sX) / denominator;
  const u = (qpx * rY - qpy * rX) / denominator;
  if (t < 0 || u < 0 || u > 1) return undefined;
  return { t, x: x1 + t * rX, y: y1 + t * rY };
}

function intersectEllipseRayWithT(shape: ShapeBounds, x1: number, y1: number, x2: number, y2: number): { t: number; x: number; y: number } | undefined {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const rx = Math.max(1, shape.width / 2);
  const ry = Math.max(1, shape.height / 2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const ox = x1 - cx;
  const oy = y1 - cy;
  const a = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry);
  const b = 2 * ((ox * dx) / (rx * rx) + (oy * dy) / (ry * ry));
  const c = (ox * ox) / (rx * rx) + (oy * oy) / (ry * ry) - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || a === 0) return undefined;
  const roots = [(-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a)].filter((t) => t > 0).sort((aRoot, bRoot) => aRoot - bRoot);
  const t = roots[0];
  return t === undefined ? undefined : { t, x: x1 + t * dx, y: y1 + t * dy };
}

function routeSelfConnector(shape: MeasuredDiagramElement | undefined) {
  const bounds = shape ? toShapeBounds(shape) : { type: "rectangle", x: 0, y: 0, width: 120, height: 80 };
  const right = bounds.x + bounds.width;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const top = bounds.y;
  const start = bounds.type === "diamond" ? { x: right + 12, y: cy - 4 } : { x: right + 12, y: cy - bounds.height * 0.18 };
  const end = bounds.type === "diamond" ? { x: cx + bounds.width * 0.28, y: top - 10 } : { x: cx + bounds.width * 0.28, y: top - 10 };
  const points = [start, { x: right + 116, y: top - 92 }, { x: cx + 26, y: top - 104 }, end];
  return { points, label: { x: right + 82, y: top - 92 }, curve: true };
}

function routeConnector(x1: number, y1: number, x2: number, y2: number, rawX1: number, rawY1: number, rawX2: number, rawY2: number, elements: MeasuredDiagramElement[], fromIndex?: number, toIndex?: number) {
  const backEdge = rawX2 < rawX1 || rawY2 < rawY1 - 40;
  if (backEdge) {
    const midX = (x1 + x2) / 2;
    const candidates = [
      { x: midX, y: Math.min(y1, y2) - 112, labelDy: -8 },
      { x: midX, y: Math.max(y1, y2) + 112, labelDy: 22 },
      { x: Math.min(x1, x2) - 112, y: (y1 + y2) / 2, labelDy: -8 },
      { x: Math.max(x1, x2) + 112, y: (y1 + y2) / 2, labelDy: -8 }
    ];
    const best = candidates
      .map((control) => ({ control, score: routeCollisionScore([{ x: x1, y: y1 }, control, { x: x2, y: y2 }], elements, true, fromIndex, toIndex) }))
      .sort((a, b) => a.score - b.score)[0].control;
    return { points: [{ x: x1, y: y1 }, best, { x: x2, y: y2 }], label: { x: best.x, y: best.y + best.labelDy }, curve: true };
  }
  const obstacle = elements
    .filter((shape) => !isConnectorElement(shape))
    .map((shape) => ({ x: numberOr(shape.x, 0) - 16, y: numberOr(shape.y, 0) - 16, width: numberOr(shape.width, 0) + 32, height: numberOr(shape.height, 0) + 32 }))
    .find((rect) => !pointInRect(x1, y1, rect) && !pointInRect(x2, y2, rect) && segmentIntersectsRect(x1, y1, x2, y2, rect));
  if (obstacle) {
    const above = Math.min(y1, y2, obstacle.y) - 38;
    const below = Math.max(y1, y2, obstacle.y + obstacle.height) + 38;
    const midY = Math.abs(above - (y1 + y2) / 2) < Math.abs(below - (y1 + y2) / 2) ? above : below;
    return { points: [{ x: x1, y: y1 }, { x: (x1 + x2) / 2, y: midY }, { x: x2, y: y2 }], label: { x: (x1 + x2) / 2, y: midY - 8 }, curve: true };
  }
  return { points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 10 }, curve: false };
}

function segmentIntersectsRect(x1: number, y1: number, x2: number, y2: number, rect: { x: number; y: number; width: number; height: number }): boolean {
  const hit = intersectRectRayWithT(rect, x1, y1, x2, y2);
  return Boolean(hit && hit.t <= 1);
}

function placeRouteLabel(route: { points: Array<{ x: number; y: number }>; curve?: boolean; label: { x: number; y: number } }, label: { text: string; fontSize?: number }, elements: MeasuredDiagramElement[]): { x: number; y: number } {
  const fontSize = label.fontSize || 16;
  const width = estimateTextWidth(label.text, fontSize) + 18;
  const height = fontSize + 10;
  const candidates = [0.5, 0.42, 0.58, 0.34, 0.66].flatMap((t) => {
    const point = sampleRoute(route.points, t, Boolean(route.curve));
    const normal = routeNormal(route.points, t, Boolean(route.curve));
    return [
      { x: point.x + normal.x * 18, y: point.y + normal.y * 18 + fontSize / 3 },
      { x: point.x - normal.x * 18, y: point.y - normal.y * 18 + fontSize / 3 }
    ];
  });
  return candidates
    .map((candidate) => ({ candidate, score: labelCollisionScore(candidate, width, height, elements) }))
    .sort((a, b) => a.score - b.score)[0]?.candidate || route.label;
}

function routeNormal(points: Array<{ x: number; y: number }>, t: number, curve: boolean): { x: number; y: number } {
  const before = sampleRoute(points, Math.max(0, t - 0.02), curve);
  const after = sampleRoute(points, Math.min(1, t + 0.02), curve);
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

function labelCollisionScore(candidate: { x: number; y: number }, width: number, height: number, elements: MeasuredDiagramElement[]): number {
  const box = { x: candidate.x - width / 2, y: candidate.y - height, width, height };
  return elements
    .filter((shape) => !isConnectorElement(shape))
    .map((shape) => ({ x: numberOr(shape.x, 0) - 8, y: numberOr(shape.y, 0) - 8, width: numberOr(shape.width, 0) + 16, height: numberOr(shape.height, 0) + 16 }))
    .reduce((score, rect) => score + (rectsOverlap(box, rect) ? 1_000 : 0), 0);
}

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function routeCollisionScore(points: Array<{ x: number; y: number }>, elements: MeasuredDiagramElement[], curve: boolean, fromIndex?: number, toIndex?: number): number {
  const obstacles = elements
    .map((shape, index) => ({ shape, index }))
    .filter(({ shape, index }) => !isConnectorElement(shape) && index !== fromIndex && index !== toIndex)
    .map(({ shape }) => ({ x: numberOr(shape.x, 0) - 34, y: numberOr(shape.y, 0) - 34, width: numberOr(shape.width, 0) + 68, height: numberOr(shape.height, 0) + 68 }));
  let score = 0;
  const samples = 36;
  for (let index = 1; index < samples - 1; index++) {
    const t = index / (samples - 1);
    const point = sampleRoute(points, t, curve);
    for (const rect of obstacles) {
      if (pointInRect(point.x, point.y, rect)) score += 1_000;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const dx = Math.max(Math.abs(point.x - cx) - rect.width / 2, 0);
      const dy = Math.max(Math.abs(point.y - cy) - rect.height / 2, 0);
      score += Math.max(0, 24 - Math.hypot(dx, dy));
    }
  }
  return score;
}

function sampleRoute(points: Array<{ x: number; y: number }>, t: number, curve: boolean): { x: number; y: number } {
  if (!curve || points.length < 3) {
    const a = points[0];
    const b = points[points.length - 1];
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }
  if (points.length === 3) {
    const [a, b, c] = points;
    const mt = 1 - t;
    return { x: mt * mt * a.x + 2 * mt * t * b.x + t * t * c.x, y: mt * mt * a.y + 2 * mt * t * b.y + t * t * c.y };
  }
  const [a, b, c, d] = points;
  const mt = 1 - t;
  return {
    x: mt * mt * mt * a.x + 3 * mt * mt * t * b.x + 3 * mt * t * t * c.x + t * t * t * d.x,
    y: mt * mt * mt * a.y + 3 * mt * mt * t * b.y + 3 * mt * t * t * c.y + t * t * t * d.y
  };
}

function renderRoughRoute(route: { points: Array<{ x: number; y: number }>; curve?: boolean }, stroke: string, seed: number, element: MeasuredDiagramElement) {
  return renderRoughPath(routePath(route.points, Boolean(route.curve)), stroke, seed, element);
}

function renderRoughPolyline(points: Array<{ x: number; y: number }>, stroke: string, seed: number, element: MeasuredDiagramElement) {
  return renderRoughPath(routePath(points, false), stroke, seed, element);
}

function routePath(points: Array<{ x: number; y: number }>, curve: boolean): string {
  if (!points.length) return "";
  if (!curve || points.length < 3) return `M ${points.map((point) => `${point.x} ${point.y}`).join(" L ")}`;
  if (points.length === 3) return `M ${points[0].x} ${points[0].y} Q ${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y}`;
  return `M ${points[0].x} ${points[0].y} C ${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y} ${points[3].x} ${points[3].y}`;
}

function renderRoughPath(path: string, stroke: string, seed: number, element: MeasuredDiagramElement) {
  const drawable = roughGenerator.path(path, {
    stroke,
    strokeWidth: typeof element.strokeWidth === "number" ? element.strokeWidth : 2.2,
    seed: seed + 100,
    roughness: typeof element.roughness === "number" ? element.roughness : 1.35,
    bowing: 1.8,
    strokeLineDash: element.strokeStyle === "dashed" ? [12, 8] : element.strokeStyle === "dotted" ? [2, 8] : undefined
  });
  return <g className="nativeSketch">{roughGenerator.toPaths(drawable).map((pathItem, index) => <path key={index} d={pathItem.d} stroke={pathItem.stroke} strokeWidth={pathItem.strokeWidth} fill="none" />)}</g>;
}

function renderNativeArrowhead(x1: number, y1: number, x2: number, y2: number, stroke: string, index: number, kind = "arrow") {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 18;
  const left: [number, number] = [x2 - size * Math.cos(angle - Math.PI / 7), y2 - size * Math.sin(angle - Math.PI / 7)];
  const right: [number, number] = [x2 - size * Math.cos(angle + Math.PI / 7), y2 - size * Math.sin(angle + Math.PI / 7)];
  if (kind === "dot") {
    const drawable = roughGenerator.circle(x2 - 5 * Math.cos(angle), y2 - 5 * Math.sin(angle), 12, { stroke, fill: stroke, fillStyle: "solid", seed: index + 210, roughness: 0.7 });
    return <g className="nativeSketch">{roughGenerator.toPaths(drawable).map((path, pathIndex) => <path key={pathIndex} d={path.d} stroke={path.stroke} strokeWidth={path.strokeWidth} fill={path.fill || stroke} />)}</g>;
  }
  if (kind === "bar") {
    const bx = 9 * Math.cos(angle + Math.PI / 2);
    const by = 9 * Math.sin(angle + Math.PI / 2);
    return renderRoughPolyline([{ x: x2 - bx, y: y2 - by }, { x: x2 + bx, y: y2 + by }], stroke, index + 220, { strokeWidth: 2.4 });
  }
  if (kind === "arrow") {
    return <g className="nativeSketch">{[left, right].map((point, pointIndex) => renderRoughPolyline([{ x: point[0], y: point[1] }, { x: x2, y: y2 }], stroke, index + 230 + pointIndex, { strokeWidth: 2.2 }))}</g>;
  }
  const drawable = roughGenerator.polygon([[x2, y2], left, right], { stroke, fill: stroke, fillStyle: "solid", strokeWidth: 1.8, seed: index + 200, roughness: 0.9 });
  return <g className="nativeSketch">{roughGenerator.toPaths(drawable).map((path, pathIndex) => <path key={pathIndex} d={path.d} stroke={path.stroke} strokeWidth={path.strokeWidth} fill={path.fill || stroke} />)}</g>;
}

function diagramBounds(elements: MeasuredDiagramElement[]) {
  const padding = 80;
  const xs = elements.flatMap((element) => [numberOr(element.x, 0), numberOr(element.x, 0) + numberOr(element.width, 0)]);
  const ys = elements.flatMap((element) => [numberOr(element.y, 0), numberOr(element.y, 0) + numberOr(element.height, 0)]);
  const minX = Math.min(...xs, 0) - padding;
  const minY = Math.min(...ys, 0) - padding;
  const maxX = Math.max(...xs, 640) + padding;
  const maxY = Math.max(...ys, 360) + padding;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

async function parseExcalidrawSource(source: string): Promise<{ ok: true; data: Record<string, unknown>; height: number } | { ok: false; error: string }> {
  try {
    const parsed = JSON.parse(source) as unknown;
    const scene = Array.isArray(parsed) ? { elements: parsed } : parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    if (!scene) return { ok: false, error: "Expected a JSON object or array of Excalidraw elements." };
    const appState = scene.appState && typeof scene.appState === "object" ? scene.appState as Record<string, unknown> : {};
    const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
    const normalizedScene = normalizeExcalidraw ? normalizeExcalidrawScene(scene) : scene;
    const elements = Array.isArray(normalizedScene.elements) ? convertToExcalidrawElements(normalizedScene.elements as never[], { regenerateIds: false }) : [];
    const height = estimateExcalidrawHeight(normalizedScene.elements);
    return {
      ok: true,
      height,
      data: {
        ...normalizedScene,
        elements,
        appState: {
          viewBackgroundColor: "transparent",
          scrollX: 0,
          scrollY: 0,
          zoom: { value: 0.85 },
          ...appState
        },
        scrollToContent: true
      }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeExcalidrawScene(scene: Record<string, unknown>): Record<string, unknown> {
  const elements = Array.isArray(scene.elements) ? scene.elements.map((element) => {
    if (!element || typeof element !== "object") return element;
    const item = { ...(element as Record<string, unknown>) };
    const label = normalizeLabel(item.label, item.text);
    if (!label || item.type === "arrow" || item.type === "line" || item.type === "text") return item;

    const fontSize = Math.min(typeof label.fontSize === "number" ? label.fontSize : 22, 18);
    const targetTextWidth = Math.max(numberOr(item.width, 0) - 56, 180);
    const wrapped = wrapLabel(label.text, fontSize, targetTextWidth);
    const measured = measureWrappedLabel(wrapped, fontSize);
    const minWidth = Math.max(numberOr(item.width, 0), measured.width + 140, 340);
    const minHeight = Math.max(numberOr(item.height, 0), measured.height + 96, 128);

    item.width = Math.ceil(minWidth);
    item.height = Math.ceil(minHeight);
    item.label = { ...label, text: padExcalidrawBoundText(wrapped), fontSize };
    if (!item.roundness && item.type === "rectangle") item.roundness = { type: 3 };
    if (item.backgroundColor === undefined) item.backgroundColor = "transparent";
    return item;
  }) : scene.elements;
  return { ...scene, elements };
}

function normalizeLabel(label: unknown, fallback: unknown): { text: string; fontSize?: number } | undefined {
  if (typeof label === "string") return { text: label };
  if (label && typeof label === "object" && typeof (label as Record<string, unknown>).text === "string") return label as { text: string; fontSize?: number };
  if (typeof fallback === "string") return { text: fallback };
  return undefined;
}

function wrapLabel(text: string, fontSize: number, targetTextWidth = 320): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return text;
  const maxWidth = Math.max(220, targetTextWidth);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function measureWrappedLabel(text: string, fontSize: number): { width: number; height: number } {
  const lineHeight = fontSize * 1.25;
  try {
    const prepared = prepareWithSegments(text, `${fontSize}px Virgil, ui-sans-serif, system-ui`, { whiteSpace: "pre-wrap" });
    const stats = measureLineStats(prepared, Number.POSITIVE_INFINITY);
    return { width: stats.maxLineWidth, height: stats.lineCount * lineHeight };
  } catch {
    const lines = text.split("\n");
    return {
      width: Math.max(...lines.map((line) => estimateTextWidth(line, fontSize)), 0),
      height: lines.length * lineHeight
    };
  }
}

function padExcalidrawBoundText(text: string): string {
  // Excalidraw's bound-text renderer can clip the first glyph when labels are generated
  // programmatically. Leading padding preserves the visible text; wrapping is computed
  // before this padding is added.
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function estimateTextWidth(text: string, fontSize: number): number {
  if (typeof document !== "undefined") {
    const canvas = estimateTextWidth.canvas || (estimateTextWidth.canvas = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.font = `${fontSize}px Virgil, ui-sans-serif, system-ui`;
      return ctx.measureText(text).width;
    }
  }
  return text.length * fontSize * 0.62;
}
estimateTextWidth.canvas = undefined as HTMLCanvasElement | undefined;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function estimateExcalidrawHeight(elements: unknown): number {
  if (!Array.isArray(elements) || !elements.length) return 360;
  const bottoms = elements.map((element) => {
    if (!element || typeof element !== "object") return 0;
    const item = element as Record<string, unknown>;
    const y = typeof item.y === "number" ? item.y : 0;
    const height = typeof item.height === "number" ? Math.abs(item.height) : 80;
    return y + height;
  });
  const tops = elements.map((element) => element && typeof element === "object" && typeof (element as Record<string, unknown>).y === "number" ? (element as Record<string, number>).y : 0);
  return Math.min(720, Math.max(300, Math.max(...bottoms) - Math.min(...tops) + 96));
}

function upsertEvent(events: MeetingEvent[], event: MeetingEvent): MeetingEvent[] {
  const index = events.findIndex((candidate) => candidate.id === event.id);
  if (index < 0) return [event, ...events];
  const next = [...events];
  next[index] = event;
  return next;
}

function formatTerminalEvent(event: MeetingEvent): string {
  const time = new Date(event.createdAt).toLocaleTimeString();
  if (event.type === "agent.message") {
    return `[${time}] assistant/${event.agentId}\n${event.text}`;
  }
  if (event.type === "utterance.final") {
    return `[${time}] host/${event.speakerLabel}\n${event.text}`;
  }
  if (event.type === "system") {
    return `[${time}] system/${event.level}\n${event.text}`;
  }
  if (event.type === "agent.trace") {
    const trace = event as MeetingEvent & { agentId?: string; channel?: string; text?: string; details?: unknown };
    const details = trace.details ? `\n${JSON.stringify(trace.details, null, 2)}` : "";
    return `[${time}] trace/${trace.agentId || "agent"}/${trace.channel || "debug"}\n${trace.text || ""}${details}`;
  }
  return `[${time}] ${event.type}\n${JSON.stringify(event, null, 2)}`;
}

interface RenderStats {
  count: number;
  markdownMin: number;
  markdownAvg: number;
  markdownMax: number;
  eventMin?: number;
  eventAvg?: number;
  eventMax?: number;
}

function summarizeRenderSamples(samples: RenderSample[]): RenderStats {
  const markdown = samples.map((sample) => sample.markdownMs);
  const event = samples.map((sample) => sample.eventToRenderMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    count: samples.length,
    markdownMin: min(markdown),
    markdownAvg: avg(markdown),
    markdownMax: max(markdown),
    eventMin: event.length ? min(event) : undefined,
    eventAvg: event.length ? avg(event) : undefined,
    eventMax: event.length ? max(event) : undefined
  };
}

function formatRenderStats(stats: RenderStats): string {
  if (!stats.count) return "[metrics] markdown renders: waiting for first render";
  const event = stats.eventAvg === undefined
    ? "event→render=n/a"
    : `event→render min/avg/max=${formatMs(stats.eventMin!)}/${formatMs(stats.eventAvg)}/${formatMs(stats.eventMax!)}`;
  return `[metrics] markdown renders=${stats.count} markdown min/avg/max=${formatMs(stats.markdownMin)}/${formatMs(stats.markdownAvg)}/${formatMs(stats.markdownMax)} ${event}`;
}

function min(values: number[]): number {
  return values.length ? Math.min(...values) : 0;
}

function max(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

interface CanvasDocument {
  agentId: string;
  text: string;
  createdAt?: string;
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

{{caption}}`,
  "excalidraw-fit-test": `# Excalidraw fit test

\`\`\`excalidraw
{
  "type": "excalidraw",
  "elements": [
    { "type": "rectangle", "x": 60, "y": 80, "width": 170, "height": 60, "strokeColor": "#1e293b", "backgroundColor": "transparent", "label": { "text": "Stable shell owns microphone push to talk and never reloads", "fontSize": 22 } },
    { "type": "rectangle", "x": 470, "y": 80, "width": 180, "height": 60, "strokeColor": "#1e293b", "backgroundColor": "transparent", "label": { "text": "Editable generative canvas renders Markdown Mermaid and Excalidraw", "fontSize": 22 } },
    { "type": "rectangle", "x": 880, "y": 80, "width": 170, "height": 60, "strokeColor": "#1e293b", "backgroundColor": "transparent", "label": { "text": "Pi bridge streams assistant updates back into the meeting", "fontSize": 22 } },
    { "type": "arrow", "x": 260, "y": 125, "width": 190, "height": 0, "strokeColor": "#475569", "endArrowhead": "arrow", "label": { "text": "audio blob", "fontSize": 16 } },
    { "type": "arrow", "x": 670, "y": 125, "width": 190, "height": 0, "strokeColor": "#475569", "endArrowhead": "arrow", "label": { "text": "events", "fontSize": 16 } },
    { "type": "rectangle", "x": 470, "y": 280, "width": 180, "height": 60, "strokeColor": "#1e293b", "backgroundColor": "transparent", "label": { "text": "Normalization layer measures labels wraps text and expands boxes before rendering", "fontSize": 22 } },
    { "type": "arrow", "x": 560, "y": 170, "width": 0, "height": 90, "strokeColor": "#475569", "endArrowhead": "arrow", "label": { "text": "layout repair", "fontSize": 16 } }
  ]
}
\`\`\``,
  "concise-diagram-test": `# Concise progressive diagram test

\`\`\`diagram
nodes: 4

edges:
  0 -> 1 "audio blob"
  1 -> 2 "events"
  1 -> 3 "layout repair"

labels:
  0: "Stable shell owns microphone push to talk and never reloads"
  1: "Editable generative canvas renders Markdown Mermaid and Excalidraw"
  2: "Pi bridge streams assistant updates back into the meeting"
  3: "Normalization layer measures labels wraps text and expands boxes before rendering"
\`\`\``,
  "native-diagram-expressive-test": `# Native diagram expressive test

\`\`\`diagram
nodes: 8

shapes:
  0: ellipse
  2: diamond
  5: diamond
  7: ellipse

styles:
  0: stroke=#60a5fa fill=#172554 fillStyle=hachure fontSize=20
  2: stroke=#facc15 fill=#422006 strokeStyle=dashed roughness=2
  5: stroke=#fb7185 fill=#4c0519 fillStyle=zigzag strokeWidth=3
  7: stroke=#34d399 fill=#052e16 opacity=0.95

edges:
  0 -> 1 "speech" arrow stroke=#60a5fa
  1 -> 2 "intent" triangle stroke=#facc15 strokeStyle=dashed
  2 -> 3 "yes" dot stroke=#34d399
  2 -> 1 "revise" bar stroke=#fb7185
  3 -> 4 "render"
  4 -> 5 "validate" triangle
  5 -> 5 "retry" arrow stroke=#fb7185
  5 -> 6 "pass" none stroke=#94a3b8
  6 -> 7 "ship" arrow stroke=#34d399 strokeWidth=3

labels:
  0: "Host speaks in stable shell"
  1: "Audio capture and transcription pipeline"
  2: "Can the assistant infer the next useful step?"
  3: "Measured native layout"
  4: "Sketch renderer with owned text"
  5: "Validation loop stays visible"
  6: "Commit completed milestone"
  7: "Meeting canvas updates live"
\`\`\``
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
