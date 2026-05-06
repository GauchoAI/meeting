import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
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
	const seen = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("meeting", "meeting: connecting");
		await initialiseCursor(ctx);
		if (listen) startListening(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
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
		if (pendingMeetingResponses <= 0) return;
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
		timer = undefined;
		streamAbort?.abort();
		streamAbort = new AbortController();
		ctx.ui.setStatus("meeting", "meeting: streaming");
		void connectEventStream(ctx, streamAbort.signal);
	}

	function startPollingFallback(ctx: ExtensionContext) {
		if (timer) clearInterval(timer);
		timer = setInterval(() => void poll(ctx), 1200);
		ctx.ui.setStatus("meeting", "meeting: polling fallback");
		void poll(ctx);
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
			"Answer the host directly. Use concise Markdown. If useful, include Mermaid diagrams or bullets; avoid mentioning implementation details unless asked.",
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
