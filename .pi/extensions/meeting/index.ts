import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { isMeetingTaskClass, setNextMeetingRoute } from "../../lib/meeting-route-state";

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
	taskClass?: unknown;
};

type ArtifactRecord = {
	kind?: string;
	slug?: string;
	title?: string;
	summary?: string;
	path?: string;
	dir?: string;
	tags?: string[];
	updatedAt?: string;
	mtime?: string;
};

type ArtifactMatch = ArtifactRecord & {
	score: number;
	lexicalScore?: number;
	reasons: string[];
};

type ArtifactIntent = {
	decision: "create_new_artifact" | "edit_current_artifact" | "open_existing_artifact" | "artifact_lookup" | "conversation_only";
	rationale: string;
	currentArtifact?: ArtifactRecord;
	bestMatch?: ArtifactMatch;
	instruction: string;
};

export default function (pi: ExtensionAPI) {
	const api = process.env.MEETING_API_URL || DEFAULT_API;
	const meetingId = process.env.MEETING_ID || DEFAULT_MEETING_ID;
	const agentId = process.env.MEETING_AGENT_ID || DEFAULT_AGENT_ID;
	const listen = process.env.MEETING_PI_LISTEN !== "false";

	let cursor = 0;
	let extensionStartedAt = Date.now();
	let timer: ReturnType<typeof setInterval> | undefined;
	let streamAbort: AbortController | undefined;
	let pendingMeetingResponses = 0;
	let currentMeetingMessageId: string | undefined;
	let lastStreamPost = 0;
	let firstUpdatePosted = false;
	let canvasToolSatisfiedTurn = false;
	let currentLatency: { utteranceId?: string; utteranceCreatedAt?: number; extensionReceivedAt?: number; agentStartedAt?: number } = {};
	let artifactWatcher: FSWatcher | undefined;
	let lastHostUtterance = "Update smart-down artifact";
	let currentTaskClass: string | undefined;
	const artifactDebounce = new Map<string, ReturnType<typeof setTimeout>>();
	const seen = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		extensionStartedAt = Date.now();
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
		if (pendingMeetingResponses <= 0) return;
		const now = Date.now();
		if (now - lastStreamPost < 350) return;
		const markdown = extractText(event.message.content).trim();
		if (!markdown) return;
		lastStreamPost = now;
		const messageId = currentMeetingMessageId || newEventId("msg");
		currentMeetingMessageId = messageId;
		await postAgentMessage(messageId, markdown, true, { surface: "status", lifecycle: "draft" });
		if (!firstUpdatePosted) {
			firstUpdatePosted = true;
			await postTrace("latency", "assistant.first_update", { ...currentLatency, firstUpdateAt: now, agentStartToFirstUpdateMs: currentLatency.agentStartedAt ? now - currentLatency.agentStartedAt : undefined, utteranceToFirstUpdateMs: currentLatency.utteranceCreatedAt ? now - currentLatency.utteranceCreatedAt : undefined, chars: markdown.length });
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (pendingMeetingResponses <= 0) return;

		const markdown = extractText(event.message.content).trim();
		if (!markdown) return;

		await postTrace("message", markdown);
		await postTrace("latency", "assistant.final", { ...currentLatency, finalAt: Date.now(), chars: markdown.length });
		pendingMeetingResponses = Math.max(0, pendingMeetingResponses - 1);
		if (canvasToolSatisfiedTurn) {
			canvasToolSatisfiedTurn = false;
			currentMeetingMessageId = undefined;
			await postTrace("debug", "suppressed assistant final after canvas tool", { chars: markdown.length });
			return;
		}
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
			await injectMeetingPrompt(text, "Meeting UI", ctx);
		},
	});

	pi.registerTool({
		name: "meeting_open_artifact",
		label: "Open Meeting Artifact",
		description: "Open an existing smart-down artifact in the Meeting UI. If path/slug are unknown, pass query; if query is omitted, the current host request is used.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Path to artifact.smart.md. If omitted, uses slug lookup or the most recent artifact." })),
			slug: Type.Optional(Type.String({ description: "Artifact slug from manifest.json, e.g. diagram-project-flow or project-flow." })),
			query: Type.Optional(Type.String({ description: "Natural-language artifact search query, e.g. Tristan document or King Arthur evidence map." })),
			delayMs: Type.Optional(Type.Number({ description: "Delay between streamed lines. Defaults to 35ms." })),
		}),
		async execute(_toolCallId, params, ctx) {
			const cwd = effectiveCwd(ctx.cwd);
			const input = normalizeArtifactParams(params);
			const artifactPath = await resolveArtifactPath(cwd, {
				path: input.path,
				slug: input.slug,
				query: input.query || lastHostUtterance,
				allowLatestFallback: Boolean(input.path || input.slug || input.query),
			});
			const markdown = await readFile(artifactPath, "utf8");
			const messageId = newEventId("artifact");
			await streamMarkdownToMeeting(messageId, markdown, Math.max(0, input.delayMs ?? 35), artifactPath);
			await rememberArtifactAccess(cwd, artifactPath, input.query || input.slug || input.path || lastHostUtterance);
			markCanvasToolSatisfied();
			return { content: [{ type: "text" as const, text: `Opened ${artifactPath}.` }], details: { artifactPath } };
		},
	});

	pi.registerTool({
		name: "meeting_find_artifact",
		label: "Find Meeting Artifact",
		description: "Search the persistent Meeting artifact index and return ranked candidates with paths that can be passed to meeting_open_artifact.",
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language artifact search query." }),
			limit: Type.Optional(Type.Number({ description: "Maximum number of candidates. Defaults to 5." })),
		}),
		async execute(_toolCallId, params, ctx) {
			const query = typeof params.query === "string" ? params.query : "";
			const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(20, Math.floor(params.limit))) : 5;
			const matches = await searchArtifacts(effectiveCwd(ctx.cwd), query, limit);
			if (!matches.length) {
				return {
					content: [{ type: "text" as const, text: `No artifact matches "${query}".` }],
					details: { query, matches: [] },
				};
			}
			const text = matches.map((match, index) => {
				const title = match.title || match.slug || match.path || "Untitled artifact";
				return `${index + 1}. ${title}\n   slug: ${match.slug || ""}\n   path: ${match.path || ""}\n   score: ${match.score}\n   why: ${match.reasons.join(", ") || "indexed artifact"}`;
			}).join("\n");
			return { content: [{ type: "text" as const, text }], details: { query, matches } };
		},
	});

	pi.registerTool({
		name: "meeting_write_artifact",
		label: "Write Meeting Artifact",
		description: "Create a separate smart-down artifact for new artifact/document/note/diagram content. Use this instead of appending unrelated new topics to the current artifact.",
		parameters: Type.Object({
			kind: Type.Optional(Type.String({ description: "Artifact kind. Defaults to note." })),
			slug: Type.String({ description: "Stable lowercase slug, e.g. napoleon-artillery-armament." }),
			title: Type.String({ description: "Artifact title." }),
			summary: Type.Optional(Type.String({ description: "Short artifact summary for the manifest and search index." })),
			tags: Type.Optional(Type.Array(Type.String({ description: "Search/index tags." }))),
			markdown: Type.String({ description: "Complete smart-down Markdown body to write." }),
			delayMs: Type.Optional(Type.Number({ description: "Delay between streamed lines. Defaults to 20ms." })),
		}),
		async execute(_toolCallId, params, ctx) {
			const cwd = effectiveCwd(ctx.cwd);
			const input = normalizeWriteArtifactParams(params);
			const args = [
				"scripts/smart-artifact.mjs",
				"write",
				"--kind", input.kind,
				"--slug", input.slug,
				"--title", input.title,
				"--body", input.markdown,
			];
			if (input.summary) args.push("--summary", input.summary);
			if (input.tags.length) args.push("--tags", input.tags.join(","));
			const stdout = await execCommand(cwd, "node", args, 30_000);
			const outputLines = stdout.trim().split(/\r?\n/).filter(Boolean);
			if (!outputLines.length) throw new Error("meeting_write_artifact did not receive an artifact path from smart-artifact.mjs");
			const artifactPath = resolve(cwd, outputLines[outputLines.length - 1]);
			await rememberArtifactAccess(cwd, artifactPath, input.title);
			const messageId = newEventId("artifact");
			await streamMarkdownToMeeting(messageId, input.markdown, Math.max(0, input.delayMs ?? 20), artifactPath);
			await postTrace("tool", "wrote smart artifact", { artifactPath, slug: input.slug, title: input.title });
			markCanvasToolSatisfied();
			return { content: [{ type: "text" as const, text: `Wrote ${artifactPath}.` }], details: { artifactPath, slug: input.slug } };
		},
	});

	pi.registerTool({
		name: "meeting_inspect_artifact",
		label: "Inspect Rendered Artifact",
		description: "Render a smart-down artifact in the browser, optionally focus a section/heading/diagram, and return screenshot paths plus DOM facts for visual review FSM loops.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Path to artifact.smart.md." })),
			slug: Type.Optional(Type.String({ description: "Artifact slug from manifest.json." })),
			query: Type.Optional(Type.String({ description: "Natural-language artifact search query." })),
			section: Type.Optional(Type.String({ description: "Heading number or heading text to focus, e.g. 6 or Excalidraw sketch." })),
			heading: Type.Optional(Type.String({ description: "Alias for section." })),
			diagram: Type.Optional(Type.Number({ description: "Zero-based diagram index to focus." })),
			image: Type.Optional(Type.Number({ description: "Zero-based Markdown image index to focus." })),
			focus: Type.Optional(Type.String({ description: "Focus selector hint: diagram:0, artifact, or text/heading." })),
			width: Type.Optional(Type.Number({ description: "Browser viewport width. Defaults to 1440." })),
			height: Type.Optional(Type.Number({ description: "Browser viewport height. Defaults to 1000." })),
			expectText: Type.Optional(Type.String({ description: "Pipe-separated text that should appear in the rendered artifact text sample." })),
			expectDiagramText: Type.Optional(Type.String({ description: "Pipe-separated text that should appear inside rendered diagram labels." })),
			minDiagrams: Type.Optional(Type.Number({ description: "Minimum expected rendered diagram count." })),
			reviewId: Type.Optional(Type.String({ description: "Persistent visual review FSM id. Defaults to a generated id." })),
			startWeb: Type.Optional(Type.Boolean({ description: "Start pnpm dev:web if the web UI is offline. Defaults to true." })),
		}),
		async execute(_toolCallId, params, ctx) {
			const cwd = effectiveCwd(ctx.cwd);
			const input = normalizeVisualInspectionParams(params);
			const reviewId = input.reviewId || newEventId("visual_review");
			const { result } = await runVisualInspection(cwd, input, reviewId);
			return {
				content: [{ type: "text" as const, text: formatVisualInspectionResult(reviewId, result) }],
				details: { reviewId, ...result },
			};
		},
	});

	pi.registerTool({
		name: "meeting_queue_visual_review",
		label: "Queue Visual Review",
		description: "Inspect an artifact, persist the visual-review FSM state, then queue a critique.review follow-up so a stronger route can judge and iterate from screenshots.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Path to artifact.smart.md." })),
			slug: Type.Optional(Type.String({ description: "Artifact slug from manifest.json." })),
			query: Type.Optional(Type.String({ description: "Natural-language artifact search query." })),
			section: Type.Optional(Type.String({ description: "Heading number or heading text to focus." })),
			diagram: Type.Optional(Type.Number({ description: "Zero-based diagram index to focus." })),
			image: Type.Optional(Type.Number({ description: "Zero-based Markdown image index to focus." })),
			expectText: Type.Optional(Type.String({ description: "Pipe-separated text that should appear in the rendered artifact text sample." })),
			expectDiagramText: Type.Optional(Type.String({ description: "Pipe-separated text that should appear inside rendered diagram labels." })),
			minDiagrams: Type.Optional(Type.Number({ description: "Minimum expected rendered diagram count." })),
			reviewId: Type.Optional(Type.String({ description: "Persistent visual review FSM id. Defaults to a generated id." })),
			maxIterations: Type.Optional(Type.Number({ description: "Maximum review/edit/check loop count for the queued reviewer. Defaults to 3." })),
		}),
		async execute(_toolCallId, params, ctx) {
			const cwd = effectiveCwd(ctx.cwd);
			const input = normalizeVisualInspectionParams(params);
			const reviewId = input.reviewId || newEventId("visual_review");
			const { artifactPath, result } = await runVisualInspection(cwd, input, reviewId);
			const maxIterations = typeof (params as { maxIterations?: unknown }).maxIterations === "number" ? Math.max(1, Math.min(6, Math.floor((params as { maxIterations: number }).maxIterations))) : 3;
			await writeVisualReviewState(cwd, reviewId, {
				state: "queued_critique",
				artifactPath,
				request: input,
				result,
				maxIterations,
				updatedAt: nowIso(),
			});
			setNextMeetingRoute({ taskClass: "critique.review", source: `visual-review:${reviewId}` });
			pi.sendUserMessage([
				"Meeting visual review FSM follow-up:",
				"taskClass: critique.review",
				`reviewId: ${reviewId}`,
				`artifactPath: ${artifactPath}`,
				`maxIterations: ${maxIterations}`,
				"state: queued_critique",
				"Use the screenshot paths and DOM facts below to judge the rendered artifact. If it is visually wrong, edit only the artifact file, then call meeting_inspect_artifact with the same reviewId. Loop until accepted or maxIterations is reached.",
				JSON.stringify(result, null, 2),
			].join("\n"), { deliverAs: "followUp" });
			return {
				content: [{ type: "text" as const, text: `Queued visual review ${reviewId} for ${artifactPath}.\n${formatVisualInspectionResult(reviewId, result)}` }],
				details: { reviewId, artifactPath, maxIterations, ...result },
			};
		},
	});

	pi.registerTool({
		name: "meeting_promote_diagram_image",
		label: "Promote Diagram Image",
		description: "Store a generated/repaired diagram image next to an artifact, save the prompt/source beside it, and replace the selected smart-down diagram block with the image.",
		parameters: Type.Object({
			artifactPath: Type.String({ description: "Path to artifact.smart.md." }),
			imagePath: Type.String({ description: "Path to generated PNG/JPG/WebP image." }),
			diagram: Type.Optional(Type.Number({ description: "Zero-based diagram block index. Defaults to 0." })),
			section: Type.Optional(Type.String({ description: "Section number or heading label for deterministic asset naming." })),
			alt: Type.Optional(Type.String({ description: "Alt text for the promoted image." })),
			prompt: Type.Optional(Type.String({ description: "Prompt used to generate or repair the image. Saved beside the PNG." })),
		}),
		async execute(_toolCallId, params, ctx) {
			const cwd = effectiveCwd(ctx.cwd);
			const input = normalizePromoteDiagramParams(params);
			const args = [
				"scripts/promote-diagram-image.mjs",
				"--cwd", cwd,
				"--artifact", input.artifactPath,
				"--image", input.imagePath,
				"--diagram", String(input.diagram),
			];
			if (input.section) args.push("--section", input.section);
			if (input.alt) args.push("--alt", input.alt);
			if (input.prompt) args.push("--prompt", input.prompt);
			const result = JSON.parse(await execCommand(cwd, "node", args, 30_000)) as Record<string, unknown>;
			await execCommand(cwd, "node", ["scripts/smart-artifact.mjs", "index"], 30_000).catch(() => undefined);
			await postTrace("tool", "promoted diagram image", result);
			return {
				content: [{ type: "text" as const, text: `Promoted diagram image:\n${JSON.stringify(result, null, 2)}` }],
				details: result,
			};
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
				surface: "canvas",
				lifecycle: "final",
			});
			markCanvasToolSatisfied();
			return { content: [{ type: "text" as const, text: "Posted Markdown to the Meeting UI." }], details: {} };
		},
	});

	function markCanvasToolSatisfied() {
		canvasToolSatisfiedTurn = true;
		pendingMeetingResponses = 0;
		currentMeetingMessageId = undefined;
	}

	async function runVisualInspection(cwd: string, input: ReturnType<typeof normalizeVisualInspectionParams>, reviewId: string): Promise<{ artifactPath: string; result: Record<string, unknown> }> {
		const artifactPath = await resolveArtifactPath(cwd, {
			path: input.path,
			slug: input.slug,
			query: input.query || lastHostUtterance,
			allowLatestFallback: Boolean(input.path || input.slug || input.query),
		});
		await writeVisualReviewState(cwd, reviewId, {
			state: "rendering",
			artifactPath,
			request: input,
			updatedAt: nowIso(),
		});
		const output = resolve(cwd, ".pi", "screenshots", `${reviewId}.png`);
		const args = [
			"scripts/visual-artifact-inspect.mjs",
			"--cwd", cwd,
			"--path", artifactPath,
			"--output", output,
		];
		if (input.section) args.push("--section", input.section);
		if (input.heading) args.push("--heading", input.heading);
		if (typeof input.diagram === "number") args.push("--diagram", String(input.diagram));
		if (typeof input.image === "number") args.push("--image", String(input.image));
		if (input.focus) args.push("--focus", input.focus);
		if (typeof input.width === "number") args.push("--width", String(input.width));
		if (typeof input.height === "number") args.push("--height", String(input.height));
		if (input.expectText) args.push("--expectText", input.expectText);
		if (input.expectDiagramText) args.push("--expectDiagramText", input.expectDiagramText);
		if (typeof input.minDiagrams === "number") args.push("--minDiagrams", String(input.minDiagrams));
		if (input.startWeb !== false) args.push("--startWeb");
		const result = JSON.parse(await execCommand(cwd, "node", args, 90_000)) as Record<string, unknown>;
		await writeVisualReviewState(cwd, reviewId, {
			state: "inspected",
			artifactPath,
			request: input,
			result,
			updatedAt: nowIso(),
		});
		await rememberArtifactAccess(cwd, artifactPath, input.query || input.slug || input.path || lastHostUtterance);
		return { artifactPath, result };
	}

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

	function startArtifactWatcher(ctx: ExtensionContext) {
		artifactWatcher?.close();
		const artifactsDir = resolve(ctx.cwd, "artifacts");
		artifactWatcher = watch(artifactsDir, { recursive: true }, (_event, filename) => {
			if (!filename || basename(String(filename)) !== "artifact.smart.md") return;
			const artifactPath = resolve(artifactsDir, String(filename));
			const previous = artifactDebounce.get(artifactPath);
			if (previous) clearTimeout(previous);
			artifactDebounce.set(artifactPath, setTimeout(() => void publishArtifactChange(artifactPath, ctx), 180));
		});
	}

	async function publishArtifactChange(artifactPath: string, ctx: ExtensionContext) {
		artifactDebounce.delete(artifactPath);
		try {
			if (!(await stat(artifactPath)).isFile()) return;
			const markdown = await readFile(artifactPath, "utf8");
			const messageId = `artifact_${Buffer.from(artifactPath).toString("base64url").slice(0, 18)}_${Date.now().toString(36)}`;
			await streamMarkdownToMeeting(messageId, markdown, 20, artifactPath);
			await commitArtifactChange(artifactPath, lastHostUtterance, ctx);
		} catch (error) {
			await postTrace("error", `artifact watcher failed: ${errorMessage(error)}`, { artifactPath });
		}
	}

	async function streamMarkdownToMeeting(messageId: string, markdown: string, delayMs: number, documentId?: string) {
		const lines = markdown.split(/(?<=\n)/);
		let buffer = "";
		for (const line of lines) {
			buffer += line;
			await postAgentMessage(messageId, buffer, true, { surface: "canvas", lifecycle: "draft", documentId });
			if (delayMs > 0) await sleep(delayMs);
		}
		await postAgentMessage(messageId, markdown, false, { surface: "canvas", lifecycle: "final", documentId });
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
		if (isRawRealtimeTranscript(event)) {
			void postTrace("debug", "stored raw Realtime transcript without sending it to Codex", { id: event.id, textChars: text.length });
			return;
		}
		const utteranceCreatedAt = Date.parse(event.createdAt);
		if (!Number.isFinite(utteranceCreatedAt) || utteranceCreatedAt < extensionStartedAt - 5000 || Date.now() - utteranceCreatedAt > 120000) {
			void postTrace("debug", "ignored stale meeting utterance", { id: event.id, createdAt: event.createdAt, textChars: text.length });
			return;
		}
		if (!ctx.isIdle()) {
			void postTrace("debug", "ignored meeting utterance while agent busy", { id: event.id, createdAt: event.createdAt, textChars: text.length });
			return;
		}
		lastHostUtterance = text;
		const extensionReceivedAt = Date.now();
		currentLatency = { utteranceId: event.id, utteranceCreatedAt, extensionReceivedAt };
		void postTrace("latency", "pi.extension.received_utterance", { ...currentLatency, eventAgeMs: currentLatency.utteranceCreatedAt ? extensionReceivedAt - currentLatency.utteranceCreatedAt : undefined, textChars: text.length });
		if (isMeetingTaskClass(event.taskClass)) {
			currentTaskClass = event.taskClass;
			setNextMeetingRoute({ taskClass: event.taskClass, source: `utterance:${event.id}` });
		} else {
			currentTaskClass = undefined;
		}
		void injectMeetingPrompt(text, event.speakerLabel || "Meeting speaker", ctx);
	}

	async function injectMeetingPrompt(text: string, speaker: string, ctx: ExtensionContext) {
		pendingMeetingResponses++;
		currentMeetingMessageId = newEventId("msg");
		lastStreamPost = 0;
		firstUpdatePosted = false;
		canvasToolSatisfiedTurn = false;
		void postTrace("input", `${speaker}: ${text}`);
		const artifactContext = await buildArtifactContext(effectiveCwd(ctx.cwd), text).catch(() => "");
		const prompt = [
			`Meeting input from ${speaker}:`,
			`taskClass: ${currentTaskClass || "conversation"}`,
			artifactContext,
			"message:",
			text,
		].filter(Boolean).join("\n");

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

	async function postAgentMessage(id: string, text: string, streaming: boolean, options: { surface?: "canvas" | "status"; lifecycle?: "draft" | "final"; documentId?: string } = {}): Promise<void> {
		await postMeetingEvent({
			id,
			type: "agent.message",
			meetingId,
			createdAt: nowIso(),
			agentId,
			format: "markdown",
			text,
			surface: options.surface || "status",
			lifecycle: options.lifecycle || (streaming ? "draft" : "final"),
			documentId: options.documentId,
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

function isRawRealtimeTranscript(event: UtteranceFinalEvent): boolean {
	return event.speakerId === "room" && event.speakerLabel === "Room (Realtime)";
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

function effectiveCwd(cwd: string | undefined): string {
	return cwd || process.cwd();
}

function normalizeArtifactParams(params: unknown): { path?: string; slug?: string; query?: string; delayMs?: number } {
	if (!params || typeof params !== "object") return {};
	const value = params as { path?: unknown; slug?: unknown; query?: unknown; delayMs?: unknown };
	const path = typeof value.path === "string" && value.path.trim() ? value.path.trim() : undefined;
	const slug = typeof value.slug === "string" && value.slug.trim() ? value.slug.trim() : undefined;
	const query = typeof value.query === "string" && value.query.trim() ? value.query.trim() : undefined;
	const delayMs = typeof value.delayMs === "number" && Number.isFinite(value.delayMs) ? value.delayMs : undefined;
	return { path, slug, query, delayMs };
}

function normalizeVisualInspectionParams(params: unknown): {
	path?: string;
	slug?: string;
	query?: string;
	section?: string;
	heading?: string;
	diagram?: number;
	image?: number;
	focus?: string;
	width?: number;
	height?: number;
	expectText?: string;
	expectDiagramText?: string;
	minDiagrams?: number;
	reviewId?: string;
	startWeb?: boolean;
} {
	if (!params || typeof params !== "object") return {};
	const value = params as Record<string, unknown>;
	return {
		path: cleanString(value.path),
		slug: cleanString(value.slug),
		query: cleanString(value.query),
		section: cleanString(value.section),
		heading: cleanString(value.heading),
		diagram: typeof value.diagram === "number" && Number.isFinite(value.diagram) ? Math.max(0, Math.floor(value.diagram)) : undefined,
		image: typeof value.image === "number" && Number.isFinite(value.image) ? Math.max(0, Math.floor(value.image)) : undefined,
		focus: cleanString(value.focus),
		width: typeof value.width === "number" && Number.isFinite(value.width) ? Math.max(360, Math.floor(value.width)) : undefined,
		height: typeof value.height === "number" && Number.isFinite(value.height) ? Math.max(320, Math.floor(value.height)) : undefined,
		expectText: cleanString(value.expectText),
		expectDiagramText: cleanString(value.expectDiagramText),
		minDiagrams: typeof value.minDiagrams === "number" && Number.isFinite(value.minDiagrams) ? Math.max(0, Math.floor(value.minDiagrams)) : undefined,
		reviewId: cleanString(value.reviewId),
		startWeb: typeof value.startWeb === "boolean" ? value.startWeb : undefined,
	};
}

function normalizePromoteDiagramParams(params: unknown): {
	artifactPath: string;
	imagePath: string;
	diagram: number;
	section?: string;
	alt?: string;
	prompt?: string;
} {
	if (!params || typeof params !== "object") throw new Error("meeting_promote_diagram_image requires parameters");
	const value = params as Record<string, unknown>;
	const artifactPath = cleanString(value.artifactPath);
	const imagePath = cleanString(value.imagePath);
	if (!artifactPath) throw new Error("meeting_promote_diagram_image requires artifactPath");
	if (!imagePath) throw new Error("meeting_promote_diagram_image requires imagePath");
	return {
		artifactPath,
		imagePath,
		diagram: typeof value.diagram === "number" && Number.isFinite(value.diagram) ? Math.max(0, Math.floor(value.diagram)) : 0,
		section: cleanString(value.section),
		alt: cleanString(value.alt),
		prompt: cleanString(value.prompt),
	};
}

function normalizeWriteArtifactParams(params: unknown): {
	kind: string;
	slug: string;
	title: string;
	summary?: string;
	tags: string[];
	markdown: string;
	delayMs?: number;
} {
	if (!params || typeof params !== "object") throw new Error("meeting_write_artifact requires parameters");
	const value = params as Record<string, unknown>;
	const slug = cleanString(value.slug);
	const title = cleanString(value.title);
	const markdown = cleanString(value.markdown);
	if (!slug) throw new Error("meeting_write_artifact requires slug");
	if (!title) throw new Error("meeting_write_artifact requires title");
	if (!markdown) throw new Error("meeting_write_artifact requires markdown");
	const rawTags = Array.isArray(value.tags) ? value.tags : [];
	return {
		kind: cleanString(value.kind) || "note",
		slug,
		title,
		summary: cleanString(value.summary),
		tags: rawTags.map(cleanString).filter((tag): tag is string => Boolean(tag)),
		markdown,
		delayMs: typeof value.delayMs === "number" && Number.isFinite(value.delayMs) ? Math.max(0, Math.floor(value.delayMs)) : undefined,
	};
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatVisualInspectionResult(reviewId: string, result: Record<string, unknown>): string {
	const stats = result.stats && typeof result.stats === "object" ? result.stats as { title?: unknown; diagramCount?: unknown; headingCount?: unknown; focus?: { text?: unknown } } : {};
	const verdict = result.verdict && typeof result.verdict === "object" ? result.verdict as { status?: unknown; failures?: unknown; warnings?: unknown; notes?: unknown } : {};
	const lines = [
		`Visual review ${reviewId}: ${String(verdict.status || "inspected")}.`,
		`Screenshot: ${String(result.screenshotPath || "")}`,
		result.focusScreenshotPath ? `Focus screenshot: ${String(result.focusScreenshotPath)}` : undefined,
		`Title: ${String(stats.title || "")}`,
		`Headings: ${String(stats.headingCount ?? 0)}; diagrams: ${String(stats.diagramCount ?? 0)}`,
		Array.isArray(verdict.failures) && verdict.failures.length ? `Failures: ${verdict.failures.join("; ")}` : undefined,
		Array.isArray(verdict.warnings) && verdict.warnings.length ? `Warnings: ${verdict.warnings.join("; ")}` : undefined,
		Array.isArray(verdict.notes) && verdict.notes.length ? `Notes: ${verdict.notes.join("; ")}` : undefined,
		stats.focus?.text ? `Focused: ${String(stats.focus.text).slice(0, 220)}` : undefined,
	].filter(Boolean);
	return lines.join("\n");
}

async function writeVisualReviewState(cwd: string, reviewId: string, state: Record<string, unknown>): Promise<void> {
	const safeId = reviewId.replace(/[^a-zA-Z0-9_.-]+/g, "-");
	const statePath = resolve(cwd, ".meeting-state", "visual-review", `${safeId}.json`);
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, `${JSON.stringify({ reviewId, ...state }, null, 2)}\n`);
}

async function resolveArtifactPath(cwd: string, request: { path?: string; slug?: string; query?: string; allowLatestFallback?: boolean }): Promise<string> {
	if (request.path) {
		const artifactPath = isAbsolute(request.path) ? request.path : resolve(cwd, request.path);
		if ((await stat(artifactPath)).isFile()) return artifactPath;
		throw new Error(`Artifact file not found: ${artifactPath}`);
	}
	const artifactsRoot = resolve(cwd, "artifacts");
	if (request.slug) {
		const indexed = await resolveIndexedArtifactPath(cwd, request.slug);
		if (indexed) return indexed;
	}
	if (request.query) {
		const matches = await searchArtifacts(cwd, request.query, 5);
		const best = matches[0];
		if (best?.path && best.score >= 2) return resolve(cwd, best.path);
		const candidates = matches.map((match) => `${match.title || match.slug || match.path} (${match.path})`).join("; ");
		throw new Error(`Artifact not found for "${request.query}".${candidates ? ` Closest candidates: ${candidates}` : ""}`);
	}
	const manifests = await findFiles(artifactsRoot, "manifest.json");
	let fallback: { path: string; updatedAt: number } | undefined;
	const matches: string[] = [];
	for (const manifestPath of manifests) {
		try {
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { slug?: string; artifact?: string; updatedAt?: string };
			const artifactPath = resolve(dirname(manifestPath), manifest.artifact || "artifact.smart.md");
			const updatedAt = Date.parse(manifest.updatedAt || "") || (await stat(artifactPath)).mtimeMs;
			if (!fallback || updatedAt > fallback.updatedAt) fallback = { path: artifactPath, updatedAt };
			if (request.slug && slugMatches(manifest.slug, request.slug)) matches.push(artifactPath);
		} catch {}
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Artifact slug "${request.slug}" is ambiguous. Use an exact slug or path.`);
	if (request.slug) throw new Error(`Artifact slug not found: ${request.slug}`);
	if (request.allowLatestFallback) {
		const indexed = await resolveIndexedArtifactPath(cwd);
		if (indexed) return indexed;
		if (fallback) return fallback.path;
	}
	throw new Error(`No smart-down artifacts found in ${artifactsRoot}`);
}

async function resolveIndexedArtifactPath(cwd: string, requestedSlug?: string): Promise<string | undefined> {
	try {
		const artifacts = await readArtifactIndex(cwd);
		if (!artifacts.length) return undefined;
		if (!requestedSlug) {
			const latest = artifacts
				.filter((artifact) => typeof artifact.path === "string")
				.sort((a, b) => dateValue(b.updatedAt || b.mtime) - dateValue(a.updatedAt || a.mtime))[0];
			return latest?.path ? resolve(cwd, latest.path) : undefined;
		}
		const matches = artifacts.filter((artifact) => slugMatches(artifact.slug, requestedSlug) && typeof artifact.path === "string");
		if (matches.length === 1) return resolve(cwd, matches[0].path as string);
		if (matches.length > 1) throw new Error(`Artifact slug "${requestedSlug}" is ambiguous. Use an exact slug or path.`);
	} catch (error) {
		if (error instanceof Error && error.message.includes("ambiguous")) throw error;
	}
	return undefined;
}

async function searchArtifacts(cwd: string, query: string, limit: number): Promise<ArtifactMatch[]> {
	const artifacts = await readArtifactIndex(cwd);
	const attention = await readArtifactAttention(cwd);
	const queryTokens = tokens(query);
	const queryText = queryTokens.join(" ");
	return artifacts
		.map((artifact) => {
			const haystack = [
				artifact.slug,
				artifact.title,
				artifact.summary,
				artifact.kind,
				artifact.path,
				...(Array.isArray(artifact.tags) ? artifact.tags : []),
			].filter(Boolean).join(" ");
			const haystackTokens = new Set(tokens(haystack));
			const reasons: string[] = [];
			let score = 0;
			let lexicalScore = 0;
			for (const token of queryTokens) {
				if (haystackTokens.has(token)) {
					const tokenScore = token.length > 4 ? 3 : 1;
					score += tokenScore;
					lexicalScore += tokenScore;
					reasons.push(token);
				}
			}
			const normalizedHaystack = normalizeText(haystack);
			if (queryText && normalizedHaystack.includes(queryText)) {
				score += 8;
				lexicalScore += 8;
				reasons.push("phrase");
			}
			const key = artifact.path || artifact.slug || "";
			const memory = key ? attention[key] : undefined;
			if (memory && lexicalScore > 0) {
				score += Math.min(3, memory.opens);
				reasons.push("session-memory");
			}
			return { ...artifact, score, lexicalScore, reasons };
		})
		.filter((artifact) => artifact.lexicalScore > 0)
		.sort((a, b) => b.score - a.score || dateValue(b.updatedAt || b.mtime) - dateValue(a.updatedAt || a.mtime))
		.map(({ lexicalScore: _lexicalScore, ...artifact }) => artifact)
		.slice(0, limit);
}

async function buildArtifactContext(cwd: string, query: string): Promise<string> {
	const artifacts = await readArtifactIndex(cwd);
	if (!artifacts.length) return "";
	const matches = await searchArtifacts(cwd, query, 5);
	const intent = await classifyArtifactIntent(cwd, query, artifacts, matches);
	const recent = artifacts
		.filter((artifact) => typeof artifact.path === "string")
		.sort((a, b) => dateValue(b.updatedAt || b.mtime) - dateValue(a.updatedAt || a.mtime))
		.slice(0, 8);
	const chosen = new Map<string, ArtifactRecord | ArtifactMatch>();
	for (const artifact of matches) if (artifact.path) chosen.set(artifact.path, artifact);
	for (const artifact of recent) if (artifact.path && !chosen.has(artifact.path)) chosen.set(artifact.path, artifact);
	const lines = [...chosen.values()].slice(0, 10).map((artifact, index) => {
		const title = artifact.title || artifact.slug || artifact.path || "Untitled artifact";
		const score = "score" in artifact ? ` score=${artifact.score}` : "";
		return `[${index + 1}] ${title} | slug=${artifact.slug || ""} | path=${artifact.path || ""}${score}`;
	});
	return [
		"artifactIntent:",
		`decision=${intent.decision}`,
		`rationale=${intent.rationale}`,
		intent.currentArtifact?.path ? `currentArtifact=${formatArtifactInline(intent.currentArtifact)}` : undefined,
		intent.bestMatch?.path ? `bestMatch=${formatArtifactInline(intent.bestMatch)} score=${intent.bestMatch.score}` : undefined,
		`instruction=${intent.instruction}`,
		"artifactIndex:",
		...lines,
		"artifactTools: use meeting_write_artifact for create_new_artifact; use meeting_find_artifact for search; use meeting_open_artifact with path, slug, or query to render one artifact; use meeting_inspect_artifact to verify rendered sections/diagrams with browser screenshots; use meeting_queue_visual_review to hand off a rendered artifact to the critique.review route; use meeting_promote_diagram_image to persist a generated diagram PNG and replace the source diagram block.",
	].filter(Boolean).join("\n");
}

async function classifyArtifactIntent(cwd: string, query: string, artifacts: ArtifactRecord[], matches: ArtifactMatch[]): Promise<ArtifactIntent> {
	const normalized = normalizeText(query);
	const currentArtifact = await currentAttentionArtifact(cwd, artifacts);
	const bestMatch = matches[0];
	const createSignal = hasCreateArtifactSignal(normalized);
	const editSignal = hasEditArtifactSignal(normalized);
	const openSignal = hasOpenArtifactSignal(normalized);
	const artifactSignal = createSignal || editSignal || openSignal || /\b(artifact|document|note|chapter|section|diagram|markdown)\b/.test(normalized);
	const currentSimilarity = currentArtifact ? similarityScore(query, artifactText(currentArtifact)) : 0;
	const bestSimilarity = bestMatch ? similarityScore(query, artifactText(bestMatch)) : 0;
	const strongCurrentMatch = Boolean(currentArtifact && currentSimilarity >= 2);
	const strongBestMatch = Boolean(bestMatch && bestSimilarity >= 2);
	const currentReference = /\b(this|current|here|same|existing|it|that)\b/.test(normalized);

	if (openSignal) {
		return {
			decision: "open_existing_artifact",
			rationale: "request asks to open/show/get an existing artifact",
			currentArtifact,
			bestMatch,
			instruction: "Resolve the requested artifact by path, slug, query, or artifactIndex entry and call meeting_open_artifact. Do not edit files."
		};
	}

	if (editSignal && (strongCurrentMatch || currentReference)) {
		return {
			decision: "edit_current_artifact",
			rationale: "request is an edit/iteration and refers to the current artifact context",
			currentArtifact,
			bestMatch,
			instruction: "Edit only the current/specified artifact, then verify or open it as appropriate."
		};
	}

	if (createSignal && !strongCurrentMatch && !strongBestMatch) {
		return {
			decision: "create_new_artifact",
			rationale: "request asks for new artifact-like content and does not semantically fit the current or matched artifact",
			currentArtifact,
			bestMatch,
			instruction: "Call meeting_write_artifact to create a separate smart artifact for this new topic. Do not append it to the current artifact just because the word chapter or section was used."
		};
	}

	if (createSignal && currentArtifact && isTopicMismatch(query, currentArtifact)) {
		return {
			decision: "create_new_artifact",
			rationale: "request asks for a new chapter/topic, but the requested topic is outside the current artifact topic",
			currentArtifact,
			bestMatch,
			instruction: "Call meeting_write_artifact to create a new smart artifact for the requested topic. Do not edit the current artifact unless the user explicitly says it belongs there."
		};
	}

	if (artifactSignal) {
		return {
			decision: "artifact_lookup",
			rationale: "request is artifact-related but target scope is ambiguous",
			currentArtifact,
			bestMatch,
			instruction: "Use artifact search/context to resolve whether this is an existing artifact edit or a new artifact. If topic containment is weak, create a new artifact instead of appending to the current one."
		};
	}

	return {
		decision: "conversation_only",
		rationale: "no artifact action signal detected",
		currentArtifact,
		bestMatch,
		instruction: "Answer conversationally unless the message asks for concrete artifact work."
	};
}

async function readArtifactIndex(cwd: string): Promise<ArtifactRecord[]> {
	const indexPath = resolve(cwd, "artifacts", "index.json");
	try {
		const index = JSON.parse(await readFile(indexPath, "utf8")) as { artifacts?: ArtifactRecord[] };
		if (Array.isArray(index.artifacts)) return index.artifacts;
	} catch {}
	return artifactRecordsFromManifests(cwd);
}

async function currentAttentionArtifact(cwd: string, artifacts: ArtifactRecord[]): Promise<ArtifactRecord | undefined> {
	const attention = await readArtifactAttention(cwd);
	const latest = Object.entries(attention)
		.filter(([path]) => artifacts.some((artifact) => artifact.path === path))
		.sort((a, b) => dateValue(b[1].lastOpenedAt) - dateValue(a[1].lastOpenedAt))[0];
	if (!latest) return undefined;
	return artifacts.find((artifact) => artifact.path === latest[0]);
}

function hasCreateArtifactSignal(normalized: string): boolean {
	return /\b(make|create|write|draft|build|add)\s+(a\s+)?new\b/.test(normalized)
		|| /\bnew\s+(artifact|document|doc|note|chapter|section|markdown|page)\b/.test(normalized)
		|| /\b(chapter|section|document|note|artifact)\s+about\b/.test(normalized);
}

function hasEditArtifactSignal(normalized: string): boolean {
	return /\b(fix|change|update|improve|iterate|revise|edit|adjust|modify|replace|remove|rerender|re-render)\b/.test(normalized)
		|| /\b(add|append)\s+(this|it|that|to|into|here)\b/.test(normalized)
		|| /\b(add|append)\b.*\b(this|current|here|same|existing|it|that)\b/.test(normalized);
}

function hasOpenArtifactSignal(normalized: string): boolean {
	return /\b(open|show|get|bring|load)\b/.test(normalized)
		&& /\b(artifact|document|doc|note|diagram|file|tristan|arthur|napoleon)\b/.test(normalized);
}

function isTopicMismatch(query: string, artifact: ArtifactRecord): boolean {
	const queryTokens = contentTokens(query);
	const artifactTokens = new Set(contentTokens(artifactText(artifact)));
	const overlap = queryTokens.filter((token) => artifactTokens.has(token));
	const topicTokens = queryTokens.filter((token) => !artifactIntentStopwords().has(token));
	return topicTokens.length >= 2 && overlap.length === 0;
}

function similarityScore(query: string, artifactTextValue: string): number {
	const artifactTokens = new Set(contentTokens(artifactTextValue));
	return contentTokens(query).filter((token) => artifactTokens.has(token)).length;
}

function artifactText(artifact: ArtifactRecord): string {
	return [artifact.title, artifact.slug, artifact.summary, artifact.kind, artifact.path, ...(artifact.tags || [])].filter(Boolean).join(" ");
}

function formatArtifactInline(artifact: ArtifactRecord): string {
	return `${artifact.title || artifact.slug || "Untitled artifact"} | slug=${artifact.slug || ""} | path=${artifact.path || ""}`;
}

function contentTokens(value: string): string[] {
	const stop = artifactIntentStopwords();
	return normalizeText(value).split(" ").filter((token) => token.length > 2 && !stop.has(token));
}

function artifactIntentStopwords(): Set<string> {
	return new Set([
		"about", "across", "add", "all", "and", "chapter", "different", "diagram", "diagrams", "doc", "document", "explanation", "for", "from", "give", "good", "here", "into", "make", "markdown", "new", "nice", "note", "now", "section", "show", "the", "this", "type", "used", "with"
	]);
}

async function artifactRecordsFromManifests(cwd: string): Promise<ArtifactRecord[]> {
	const artifactsRoot = resolve(cwd, "artifacts");
	const manifests = await findFiles(artifactsRoot, "manifest.json");
	const records: ArtifactRecord[] = [];
	for (const manifestPath of manifests) {
		try {
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ArtifactRecord & { artifact?: string };
			const artifactPath = resolve(dirname(manifestPath), manifest.artifact || "artifact.smart.md");
			const info = await stat(artifactPath);
			records.push({
				...manifest,
				path: artifactPath.slice(cwd.length + 1),
				dir: dirname(artifactPath).slice(cwd.length + 1),
				mtime: info.mtime.toISOString(),
			});
		} catch {}
	}
	return records;
}

async function rememberArtifactAccess(cwd: string, artifactPath: string, query: string | undefined): Promise<void> {
	const statePath = resolve(cwd, ".meeting-state", "artifact-attention.json");
	const key = artifactPath.startsWith(cwd) ? artifactPath.slice(cwd.length + 1) : artifactPath;
	const attention = await readArtifactAttention(cwd);
	const previous = attention[key] || { opens: 0 };
	attention[key] = {
		opens: previous.opens + 1,
		lastOpenedAt: nowIso(),
		lastQuery: query,
	};
	await mkdir(dirname(statePath), { recursive: true });
	await writeFile(statePath, `${JSON.stringify(attention, null, 2)}\n`);
}

async function readArtifactAttention(cwd: string): Promise<Record<string, { opens: number; lastOpenedAt?: string; lastQuery?: string }>> {
	const statePath = resolve(cwd, ".meeting-state", "artifact-attention.json");
	try {
		const parsed = JSON.parse(await readFile(statePath, "utf8")) as Record<string, { opens?: number; lastOpenedAt?: string; lastQuery?: string }>;
		return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, { opens: typeof value.opens === "number" ? value.opens : 0, lastOpenedAt: value.lastOpenedAt, lastQuery: value.lastQuery }]));
	} catch {
		return {};
	}
}

function slugMatches(candidate: unknown, requested: string): boolean {
	return typeof candidate === "string" && (candidate === requested || candidate === requested.replace(/^note-/, "") || `note-${candidate}` === requested);
}

function dateValue(value: unknown): number {
	return typeof value === "string" ? Date.parse(value) || 0 : 0;
}

function tokens(value: string): string[] {
	const stop = new Set(["a", "an", "and", "are", "bring", "document", "for", "get", "give", "me", "of", "open", "please", "show", "the", "to"]);
	return normalizeText(value).split(" ").filter((token) => token.length > 1 && !stop.has(token));
}

function normalizeText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function execGit(cwd: string, args: string[]): Promise<string> {
	return execCommand(cwd, "git", args);
}

function execCommand(cwd: string, command: string, args: string[], timeoutMs = 30_000): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr || error.message));
			else resolvePromise(stdout);
		});
		child.on("error", reject);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
