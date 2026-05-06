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
	let pendingMeetingResponses = 0;
	const seen = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("meeting", "meeting: connecting");
		await initialiseCursor(ctx);
		if (listen) startPolling(ctx);
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (pendingMeetingResponses <= 0) return;

		const markdown = extractText(event.message.content).trim();
		if (!markdown) return;

		pendingMeetingResponses = Math.max(0, pendingMeetingResponses - 1);
		await postMeetingEvent({
			id: newEventId("msg"),
			type: "agent.message",
			meetingId,
			createdAt: nowIso(),
			agentId,
			format: "markdown",
			text: markdown,
		}).catch((error) => ctx.ui.notify(`Meeting post failed: ${errorMessage(error)}`, "error"));
	});

	pi.registerCommand("meeting-connect", {
		description: "Connect this Pi session to the local Meeting UI event stream",
		handler: async (_args, ctx) => {
			await initialiseCursor(ctx);
			startPolling(ctx);
			ctx.ui.notify(`Meeting bridge connected to ${api}`, "success");
		},
	});

	pi.registerCommand("meeting-disconnect", {
		description: "Disconnect this Pi session from the Meeting UI event stream",
		handler: async (_args, ctx) => {
			if (timer) clearInterval(timer);
			timer = undefined;
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

	function startPolling(ctx: ExtensionContext) {
		if (timer) clearInterval(timer);
		timer = setInterval(() => void poll(ctx), 1200);
		ctx.ui.setStatus("meeting", "meeting: listening");
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
		injectMeetingPrompt(text, event.speakerLabel || "Meeting speaker", ctx);
	}

	function injectMeetingPrompt(text: string, speaker: string, ctx: ExtensionContext) {
		pendingMeetingResponses++;
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
