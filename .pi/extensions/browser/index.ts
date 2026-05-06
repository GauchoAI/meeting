import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description: "Open or inspect a URL in a Chrome DevTools browser and return a screenshot image.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "URL to open before capturing. Defaults to the Meeting stable shell." })),
			output: Type.Optional(Type.String({ description: "Optional file path for the PNG screenshot." })),
			width: Type.Optional(Type.Number({ description: "Viewport width. Default 1440." })),
			height: Type.Optional(Type.Number({ description: "Viewport height. Default 1000." })),
		}),
		async execute(_toolCallId, params) {
			const url = params.url || "http://localhost:5173/stable.html";
			const output = resolve(params.output || `.pi/screenshots/browser-${Date.now()}.png`);
			const port = Number(process.env.BROWSER_DEBUG_PORT || 9222);
			const width = params.width || 1440;
			const height = params.height || 1000;

			await ensureBrowser(port, url, width, height);
			const target = await getOrCreateTarget(port, url);
			const image = await capture(target.webSocketDebuggerUrl, width, height);
			await mkdir(dirname(output), { recursive: true });
			await writeFile(output, Buffer.from(image, "base64"));

			return {
				content: [
					{ type: "text" as const, text: `Screenshot captured: ${output}` },
					{ type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: image } },
				],
				details: { output, url, width, height },
			};
		},
	});
}

async function ensureBrowser(port: number, launchUrl: string, width: number, height: number): Promise<void> {
	if (await isDebugPortReady(port)) return;
	const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	const profile = resolve(process.env.BROWSER_PROFILE_DIR || ".pi/browser-profile");
	spawn(chrome, [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		`--window-size=${width},${height}`,
		"--no-first-run",
		"--no-default-browser-check",
		launchUrl,
	], { detached: true, stdio: "ignore" }).unref();

	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await isDebugPortReady(port)) return;
		await sleep(200);
	}
	throw new Error(`Chrome DevTools port ${port} did not become ready`);
}

async function isDebugPortReady(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`);
		return res.ok;
	} catch {
		return false;
	}
}

async function getOrCreateTarget(port: number, targetUrl: string): Promise<{ webSocketDebuggerUrl: string }> {
	const list = await fetchJson(`http://127.0.0.1:${port}/json/list`) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
	const existing = list.find((target) => target.type === "page" && String(target.url || "").startsWith(targetUrl));
	if (existing?.webSocketDebuggerUrl) return { webSocketDebuggerUrl: existing.webSocketDebuggerUrl };

	const created = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" }) as { webSocketDebuggerUrl?: string };
	if (!created.webSocketDebuggerUrl) throw new Error("Could not create browser target");
	return { webSocketDebuggerUrl: created.webSocketDebuggerUrl };
}

async function capture(wsUrl: string, width: number, height: number): Promise<string> {
	const cdp = await connectCdp(wsUrl);
	try {
		await cdp.send("Page.enable");
		await cdp.send("Runtime.enable");
		await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
		await cdp.send("Page.bringToFront");
		await cdp.send("Page.reload", { ignoreCache: false });
		await cdp.waitFor("Page.loadEventFired", 8_000).catch(() => undefined);
		await sleep(500);
		const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }) as { data: string };
		return result.data;
	} finally {
		cdp.close();
	}
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`${url} returned ${res.status}`);
	return await res.json();
}

interface CdpClient {
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	waitFor(method: string, ms?: number): Promise<unknown>;
	close(): void;
}

function connectCdp(wsUrl: string): Promise<CdpClient> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		let id = 0;
		const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
		const listeners = new Map<string, (params: unknown) => void>();
		const timeout = setTimeout(() => reject(new Error("CDP websocket timeout")), 5000);

		ws.addEventListener("open", () => {
			clearTimeout(timeout);
			resolve({
				send(method, params = {}) {
					const callId = ++id;
					ws.send(JSON.stringify({ id: callId, method, params }));
					return new Promise((res, rej) => pending.set(callId, { resolve: res, reject: rej }));
				},
				waitFor(method, ms = 5000) {
					return new Promise((res, rej) => {
						const timer = setTimeout(() => {
							listeners.delete(method);
							rej(new Error(`Timed out waiting for ${method}`));
						}, ms);
						listeners.set(method, (params) => {
							clearTimeout(timer);
							res(params);
						});
					});
				},
				close() { ws.close(); },
			});
		});
		ws.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
			if (message.id && pending.has(message.id)) {
				const entry = pending.get(message.id)!;
				pending.delete(message.id);
				message.error ? entry.reject(new Error(message.error.message || JSON.stringify(message.error))) : entry.resolve(message.result);
			} else if (message.method && listeners.has(message.method)) {
				const listener = listeners.get(message.method)!;
				listeners.delete(message.method);
				listener(message.params);
			}
		});
		ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
