#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const url = process.argv[2] || "http://localhost:5173/stable.html";
const output = resolve(process.argv[3] || ".pi/screenshots/browser.png");
const port = Number(process.env.BROWSER_DEBUG_PORT || 9222);
const width = Number(process.env.BROWSER_WIDTH || 1440);
const height = Number(process.env.BROWSER_HEIGHT || 1000);

await ensureBrowser(port, url, width, height);
const target = await getOrCreateTarget(port, url);
const image = await capture(port, target.webSocketDebuggerUrl, width, height);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.from(image, "base64"));
console.log(output);

async function ensureBrowser(port, launchUrl, w, h) {
  if (await isDebugPortReady(port)) return;
  const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profile = resolve(process.env.BROWSER_PROFILE_DIR || ".pi/browser-profile");
  spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`,
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

async function isDebugPortReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function getOrCreateTarget(port, targetUrl) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const existing = list.find((target) => target.type === "page" && String(target.url || "").startsWith(targetUrl));
  if (existing?.webSocketDebuggerUrl) return existing;

  const created = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!created.webSocketDebuggerUrl) throw new Error("Could not create browser target");
  return created;
}

async function capture(_port, wsUrl, w, h) {
  const cdp = await connectCdp(wsUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.bringToFront");
    await cdp.send("Page.reload", { ignoreCache: false });
    await cdp.waitFor("Page.loadEventFired", 8_000).catch(() => undefined);
    await sleep(500);
    const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    return result.data;
  } finally {
    cdp.close();
  }
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return await res.json();
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    const timeout = setTimeout(() => reject(new Error("CDP websocket timeout")), 5000);

    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve({
        send(method, params = {}) {
          const callId = ++id;
          ws.send(JSON.stringify({ id: callId, method, params }));
          return new Promise((res, rej) => pending.set(callId, { res, rej }));
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
      const message = JSON.parse(String(event.data));
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? rej(new Error(message.error.message || JSON.stringify(message.error))) : res(message.result);
      } else if (message.method && listeners.has(message.method)) {
        const listener = listeners.get(message.method);
        listeners.delete(message.method);
        listener(message.params);
      }
    });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
