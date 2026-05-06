import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Type } from "typebox";

const DEFAULT_API = "http://localhost:4317";
const DEFAULT_MEETING_ID = "local-demo";
const DEFAULT_AGENT_ID = "pi-agent";

type MeetingEvent = {
	id: string;
	type: string;
	meetingId: string;
	createdAt: string;
	[key: string]: unknown;
};

type UtteranceFinalEvent = MeetingEvent & {
	type: "utterance.final";
	speakerId: string;
	speakerLabel: string;
	text: string;
	startMs: number;
	endMs: number;
};

export default function (pi: ExtensionAPI) {
	const api = process.env.MEETING_API_URL || DEFAULT_API;
	const meetingId = process.env.MEETING_ID || DEFAULT_MEETING_ID;
	const agentId = process.env.MEETING_AGENT_ID || DEFAULT_AGENT_ID;
	const listen = process.env.MEETING_PI_LISTEN !== "false";

	let cursor = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	let streamAbort: AbortController | undefined;
	let pendingMeetingResponses = 0;
	let currentMeetingMessageId: string | undefined;
	let lastStreamPost = 0;
	let firstUpdatePosted = false;
	let currentLatency: { utteranceId?: string; utteranceCreatedAt?: number; extensionReceivedAt?: number; agentStartedAt?: number } = {};
	let artifactWatcher: FSWatcher | undefined;
	let lastHostUtterance = "Update smart-down artifact";
	let suppressMeetingAssistantResponse = false;
	const artifactDebounce = new Map<string, ReturnType<typeof setTimeout>>();
	const seen = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("meeting", "meeting: connecting");
		await initialiseCursor(ctx);
		startArtifactWatcher(ctx);
		if (listen) startListening(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		artifactWatcher?.close();
		for (const timeout of artifactDebounce.values()) clearTimeout(timeout);
		streamAbort?.abort();
	});

	pi.on("agent_start", async () => {
		currentLatency.agentStartedAt = Date.now();
		await postTrace("agent", "agent_start", currentLatency.utteranceId ? { ...currentLatency, utteranceToAgentStartMs: currentLatency.utteranceCreatedAt ? currentLatency.agentStartedAt - currentLatency.utteranceCreatedAt : undefined } : undefined);
	});

	pi.on("agent_end", async () => {
		await postTrace("agent", "agent_end");
	});

	pi.on("tool_call", async (event) => {
		await postTrace("tool", `tool_call: ${event.toolName}`, event.input);
	});

	pi.on("tool_result", async (event) => {
		await postTrace("tool", `tool_result: ${event.toolName}`, { isError: event.isError, content: event.content });
	});

	pi.on("message_update", async (event) => {
		if (pendingMeetingResponses <= 0 || suppressMeetingAssistantResponse) return;
		const now = Date.now();
		if (now - lastStreamPost < 350) return;
		const markdown = extractText(event.message.content).trim();
		if (!markdown) return;
		lastStreamPost = now;
		if (!firstUpdatePosted) {
			firstUpdatePosted = true;
			await postTrace("latency", "assistant.first_update", { ...currentLatency, firstUpdateAt: now, agentStartToFirstUpdateMs: currentLatency.agentStartedAt ? now - currentLatency.agentStartedAt : undefined, utteranceToFirstUpdateMs: currentLatency.utteranceCreatedAt ? now - currentLatency.utteranceCreatedAt : undefined, chars: markdown.length });
		}
		currentMeetingMessageId ||= newEventId("msg");
		await postAgentMessage(currentMeetingMessageId, markdown, true).catch(() => undefined);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (pendingMeetingResponses <= 0) return;

		const markdown = extractText(event.message.content).trim();
		if (!markdown) return;
		if (suppressMeetingAssistantResponse) {
			await postTrace("message", `suppressed assistant response: ${markdown}`);
			pendingMeetingResponses = Math.max(0, pendingMeetingResponses - 1);
			currentMeetingMessageId = undefined;
			suppressMeetingAssistantResponse = false;
			return;
		}

		await postTrace("message", markdown);
		await postTrace("latency", "assistant.final", { ...currentLatency, finalAt: Date.now(), chars: markdown.length });
		pendingMeetingResponses = Math.max(0, pendingMeetingResponses - 1);
		const messageId = currentMeetingMessageId || newEventId("msg");
		currentMeetingMessageId = undefined;
		await postAgentMessage(messageId, markdown, false).catch((error) => ctx.ui.notify(`Meeting post failed: ${errorMessage(error)}`, "error"));
	});

	pi.registerCommand("meeting-connect", {
		description: "Connect this Pi session to the local Meeting UI event stream",
		handler: async (_args, ctx) => {
			await initialiseCursor(ctx);
			startListening(ctx);
			ctx.ui.notify(`Meeting bridge connected to ${api}`, "success");
		},
	});

	pi.registerCommand("meeting-disconnect", {
		description: "Disconnect this Pi session from the Meeting UI event stream",
		handler: async (_args, ctx) => {
			if (timer) clearInterval(timer);
			timer = undefined;
			streamAbort?.abort();
			streamAbort = undefined;
			ctx.ui.setStatus("meeting", "meeting: off");
			ctx.ui.notify("Meeting bridge disconnected", "info");
		},
	});

	pi.registerCommand("meeting-say", {
		description: "Test the Meeting bridge by sending text as if it came from the UI",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify("Usage: /meeting-say <message>", "warning");
				return;
			}
			injectMeetingPrompt(text, "Meeting UI", ctx);
		},
	});

	pi.registerTool({
		name: "meeting_open_artifact",
		label: "Open Meeting Artifact",
		description: "Open an existing smart-down artifact in the Meeting UI by streaming its Markdown line by line, as if it were being written.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Path to artifact.smart.md. If omitted, uses slug lookup or the most recent artifact." })),
			slug: Type.Optional(Type.String({ description: "Artifact slug from manifest.json, e.g. diagram-project-flow or project-flow." })),
			delayMs: Type.Optional(Type.Number({ description: "Delay between streamed lines. Defaults to 35ms." })),
		}),
		async execute(_toolCallId, params, ctx) {
			const artifactPath = await resolveArtifactPath(ctx.cwd, params.path, params.slug);
			const markdown = await readFile(artifactPath, "utf8");
			const messageId = newEventId("artifact");
			await streamMarkdownToMeeting(messageId, markdown, Math.max(0, params.delayMs ?? 35));
			return { content: [{ type: "text" as const, text: `Opened ${artifactPath}.` }], details: { artifactPath } };
		},
	});

	pi.registerTool({
		name: "meeting_post_markdown",
		label: "Post Markdown to Meeting",
		description: "Render Markdown in the Meeting UI side panel. Mermaid code blocks are supported.",
		parameters: Type.Object({
			markdown: Type.String({ description: "Markdown to render in the meeting UI" }),
			title: Type.Optional(Type.String({ description: "Optional title to prepend as a Markdown H1" })),
		}),
		async execute(_toolCallId, params) {
			const text = params.title ? `# ${params.title}\n\n${params.markdown}` : params.markdown;
			await postMeetingEvent({
				id: newEventId("msg"),
				type: "agent.message",
				meetingId,
				createdAt: nowIso(),
				agentId,
				format: "markdown",
				text,
			});
			return { content: [{ type: "text" as const, text: "Posted Markdown to the Meeting UI." }], details: {} };
		},
	});

	function startListening(ctx: ExtensionContext) {
		if (timer) clearInterval(timer);
		streamAbort?.abort();
		streamAbort = new AbortController();
		ctx.ui.setStatus("meeting", "meeting: streaming");
		void connectEventStream(ctx, streamAbort.signal);
		// Keep a low-frequency poll active even when SSE appears connected. After extension reloads
		// or dev-server restarts, we have seen an open SSE socket stop delivering new events.
		timer = setInterval(() => void poll(ctx), 1500);
	}

	function startPollingFallback(ctx: ExtensionContext) {
		if (timer) clearInterval(timer);
		timer = setInterval(() => void poll(ctx), 1200);
		ctx.ui.setStatus("meeting", "meeting: polling fallback");
		void poll(ctx);
	}

	function startArtifactWatcher(ctx: ExtensionContext) {
		try {
			artifactWatcher?.close();
			const artifactsDir = resolve(ctx.cwd, "artifacts");
			artifactWatcher = watch(artifactsDir, { recursive: true }, (_event, filename) => {
				if (!filename || basename(String(filename)) !== "artifact.smart.md") return;
				const artifactPath = resolve(artifactsDir, String(filename));
				const previous = artifactDebounce.get(artifactPath);
				if (previous) clearTimeout(previous);
				artifactDebounce.set(artifactPath, setTimeout(() => void publishArtifactChange(artifactPath, ctx), 180));
			});
		} catch (error) {
			void postTrace("error", `artifact watcher unavailable: ${errorMessage(error)}`);
		}
	}

	async function publishArtifactChange(artifactPath: string, ctx: ExtensionContext) {
		artifactDebounce.delete(artifactPath);
		try {
			if (!(await stat(artifactPath)).isFile()) return;
			const markdown = await readFile(artifactPath, "utf8");
			const messageId = `artifact_${Buffer.from(artifactPath).toString("base64url").slice(0, 18)}_${Date.now().toString(36)}`;
			await streamMarkdownToMeeting(messageId, markdown, 20);
			await commitArtifactChange(artifactPath, lastHostUtterance, ctx);
		} catch (error) {
			await postTrace("error", `artifact watcher failed: ${errorMessage(error)}`, { artifactPath });
		}
	}

	async function streamMarkdownToMeeting(messageId: string, markdown: string, delayMs: number) {
		const lines = markdown.split(/(?<=\n)/);
		let buffer = "";
		for (const line of lines) {
			buffer += line;
			await postAgentMessage(messageId, buffer, true);
			if (delayMs > 0) await sleep(delayMs);
		}
		await postAgentMessage(messageId, markdown, false);
	}

	async function commitArtifactChange(artifactPath: string, message: string, ctx: ExtensionContext) {
		const relativeArtifact = artifactPath.startsWith(ctx.cwd) ? artifactPath.slice(ctx.cwd.length + 1) : artifactPath;
		const manifestPath = resolve(dirname(artifactPath), "manifest.json");
		const files = [relativeArtifact];
		try { if ((await stat(manifestPath)).isFile()) files.push(manifestPath.slice(ctx.cwd.length + 1)); } catch {}
		await execGit(ctx.cwd, ["add", ...files]);
		const diffState = await execGit(ctx.cwd, ["diff", "--cached", "--quiet"]).then(() => "clean", () => "dirty");
		if (diffState === "clean") return;
		await execGit(ctx.cwd, ["commit", "-m", message.trim() || "Update smart-down artifact"]);
		await execGit(ctx.cwd, ["push"]).catch((error) => postTrace("error", `artifact watcher push failed: ${errorMessage(error)}`, { artifactPath }));
	}

	async function initialiseCursor(ctx: ExtensionContext) {
		try {
			const snapshot = await getEvents(0);
			cursor = snapshot.next;
			ctx.ui.setStatus("meeting", "meeting: ready");
		} catch (error) {
			ctx.ui.setStatus("meeting", "meeting: offline");
			ctx.ui.notify(`Meeting API unavailable at ${api}: ${errorMessage(error)}`, "warning");
		}
	}

	async function connectEventStream(ctx: ExtensionContext, signal: AbortSignal) {
		try {
			const res = await fetch(`${api}/events/stream`, { signal });
			if (!res.ok || !res.body) throw new Error(`GET /events/stream returned ${res.status}`);
			ctx.ui.setStatus("meeting", "meeting: streaming");
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (!signal.aborted) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary = buffer.indexOf("\n\n");
				while (boundary >= 0) {
					const raw = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					handleSseBlock(raw, ctx);
					boundary = buffer.indexOf("\n\n");
				}
			}
			if (!signal.aborted) startPollingFallback(ctx);
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.setStatus("meeting", "meeting: stream reconnecting");
				await postTrace("latency", "pi.extension.stream_error", { error: errorMessage(error) });
				startPollingFallback(ctx);
			}
		}
	}

	function handleSseBlock(raw: string, ctx: ExtensionContext) {
		const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
		if (!data) return;
		try {
			const event = JSON.parse(data) as MeetingEvent | { next?: number };
			if (typeof (event as { next?: unknown }).next === "number") cursor = (event as { next: number }).next;
			if ((event as MeetingEvent).type === "utterance.final" && !seen.has((event as MeetingEvent).id)) {
				seen.add((event as MeetingEvent).id);
				handleUtterance(event as UtteranceFinalEvent, ctx);
			}
		} catch {
			// Ignore malformed SSE blocks.
		}
	}

	async function poll(ctx: ExtensionContext) {
		try {
			const payload = await getEvents(cursor);
			cursor = payload.next;
			ctx.ui.setStatus("meeting", "meeting: listening");
			for (const event of payload.events) {
				if (event.type !== "utterance.final") continue;
				if (seen.has(event.id)) continue;
				seen.add(event.id);
				handleUtterance(event as UtteranceFinalEvent, ctx);
			}
		} catch {
			ctx.ui.setStatus("meeting", "meeting: offline");
		}
	}

	function handleUtterance(event: UtteranceFinalEvent, ctx: ExtensionContext) {
		const text = event.text.trim();
		if (!text || isIgnorableTranscript(text)) return;
		lastHostUtterance = text;
		suppressMeetingAssistantResponse = isArtifactSurfaceRequest(text);
		const extensionReceivedAt = Date.now();
		const utteranceCreatedAt = Date.parse(event.createdAt);
		currentLatency = { utteranceId: event.id, utteranceCreatedAt: Number.isFinite(utteranceCreatedAt) ? utteranceCreatedAt : undefined, extensionReceivedAt };
		void postTrace("latency", "pi.extension.received_utterance", { ...currentLatency, eventAgeMs: currentLatency.utteranceCreatedAt ? extensionReceivedAt - currentLatency.utteranceCreatedAt : undefined, textChars: text.length });
		injectMeetingPrompt(text, event.speakerLabel || "Meeting speaker", ctx);
	}

	function injectMeetingPrompt(text: string, speaker: string, ctx: ExtensionContext) {
		pendingMeetingResponses++;
		currentMeetingMessageId = newEventId("msg");
		lastStreamPost = 0;
		firstUpdatePosted = false;
		void postTrace("input", `${speaker}: ${text}`);
		const prompt = [
			`The host spoke in the Meeting UI as ${speaker}:`,
			"",
			`> ${text}`,
			"",
			"Decide whether this is a work request or a conversational request.",
			"If it asks to fix, change, implement, improve, iterate, inspect, validate, render, or create/update an artifact/file: perform only the necessary work now with tools and continue until complete.",
			"To open an existing smart-down artifact in the Meeting UI, use meeting_open_artifact; do not read and paste the file yourself.",
			"For smart-down artifact edits, edit only the artifact file in place, then stop without a final Markdown status. The artifact watcher will stream the file line by line, commit with the host utterance as the commit message, and push."
			"For code implementation work, validate when appropriate and commit only when explicitly requested or when the repo workflow clearly requires it.",
			"If it only asks for explanation or brainstorming: answer the host directly with concise Markdown.",
			"Do not merely acknowledge actionable work requests.",
		].join("\n");

		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify("Meeting prompt queued as follow-up", "info");
		}
	}

	async function getEvents(since: number): Promise<{ events: MeetingEvent[]; next: number }> {
		const res = await fetch(`${api}/events?since=${since}`);
		if (!res.ok) throw new Error(`GET /events returned ${res.status}`);
		return await res.json() as { events: MeetingEvent[]; next: number };
	}

	async function postAgentMessage(id: string, text: string, streaming: boolean): Promise<void> {
		await postMeetingEvent({
			id,
			type: "agent.message",
			meetingId,
			createdAt: nowIso(),
			agentId,
			format: "markdown",
			text,
			streaming,
		});
	}

	async function postTrace(channel: "input" | "agent" | "message" | "tool" | "error" | "debug" | "latency", text: string, details?: unknown): Promise<void> {
		await postMeetingEvent({
			id: newEventId("trace"),
			type: "agent.trace",
			meetingId,
			createdAt: nowIso(),
			agentId,
			channel,
			text,
			details,
		}).catch(() => undefined);
	}

	async function postMeetingEvent(event: MeetingEvent): Promise<void> {
		const res = await fetch(`${api}/events`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event),
		});
		if (!res.ok) throw new Error(`POST /events returned ${res.status}`);
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function isIgnorableTranscript(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	if (/^[\[(]\s*[^\])]{1,80}\s*[\])]$/.test(normalized)) return true;
	if (/^[\[(]?\s*(blank_audio|no audio|silence|music|noise|background_noise|whooshing|wind|static|keyboard clicking|typing|clicking|people chattering|chattering|background chatter|sighs?|breathing|cough|coughing|crickets chirping|crickets|chirping|bell ringing|ringing)\s*[\])]?$/i.test(normalized)) return true;

	const words = normalized.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const filler = new Set(["um", "uh", "er", "ah", "okay", "ok", "so", "this", "that", "is", "like"]);
	const fillerCount = words.filter((word) => filler.has(word)).length;
	const uniqueWords = new Set(words);
	return words.length >= 8 && (fillerCount / words.length > 0.75 || uniqueWords.size <= 4);
}

function newEventId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

async function resolveArtifactPath(cwd: string, requestedPath?: string, requestedSlug?: string): Promise<string> {
	if (requestedPath) return resolve(cwd, requestedPath);
	const artifactsRoot = resolve(cwd, "artifacts");
	const manifests = await findFiles(artifactsRoot, "manifest.json");
	let fallback: { path: string; updatedAt: number } | undefined;
	for (const manifestPath of manifests) {
		try {
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { slug?: string; artifact?: string; updatedAt?: string };
			const artifactPath = resolve(dirname(manifestPath), manifest.artifact || "artifact.smart.md");
			const updatedAt = Date.parse(manifest.updatedAt || "") || (await stat(artifactPath)).mtimeMs;
			if (!fallback || updatedAt > fallback.updatedAt) fallback = { path: artifactPath, updatedAt };
			if (requestedSlug && (manifest.slug === requestedSlug || `${manifest.slug}`.includes(requestedSlug))) return artifactPath;
		} catch {}
	}
	if (fallback) return fallback.path;
	throw new Error(`No smart-down artifacts found in ${artifactsRoot}`);
}

async function findFiles(root: string, name: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string) {
		let entries: string[];
		try { entries = await readdir(dir); } catch { return; }
		for (const entry of entries) {
			const path = resolve(dir, entry);
			const info = await stat(path);
			if (info.isDirectory()) await walk(path);
			else if (entry === name) out.push(path);
		}
	}
	await walk(root);
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isArtifactSurfaceRequest(text: string): boolean {
	const normalized = text.toLowerCase();
	return normalized.includes("hot-reload")
		|| normalized.includes("hot reload")
		|| normalized.includes("file watcher")
		|| normalized.includes("filewatcher")
		|| /open\s+(?:the\s+)?diagram/.test(normalized)
		|| /instead of .+\b(?:say|write|label|word)\b/.test(normalized);
}

function execGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("git", args, { cwd }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr || error.message));
			else resolvePromise(stdout);
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
