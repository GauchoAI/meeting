#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const cwd = resolve(args.cwd || process.cwd());
const artifactPath = args.path ? (isAbsolute(args.path) ? args.path : resolve(cwd, args.path)) : undefined;
if (!artifactPath) throw new Error("Usage: visual-artifact-inspect.mjs --path <artifact.smart.md> [--section <heading>] [--diagram 0]");

const port = Number(args.port || process.env.BROWSER_DEBUG_PORT || 9222);
const width = Number(args.width || process.env.BROWSER_WIDTH || 1440);
const height = Number(args.height || process.env.BROWSER_HEIGHT || 1000);
const webUrl = String(args.url || process.env.MEETING_WEB_URL || "http://localhost:5173/");
const output = resolve(cwd, args.output || `.pi/screenshots/artifact-inspect-${Date.now().toString(36)}.png`);
const focusOutput = resolve(cwd, args.focusOutput || output.replace(/\.png$/i, ".focus.png"));

if (args.startWeb) await ensureWebServer(cwd, webUrl);

const markdown = await readFile(artifactPath, "utf8");
const inspectUrl = buildInspectUrl(webUrl, markdown, args);
await ensureBrowser(port, inspectUrl, width, height);
const target = await getOrCreateTarget(port, inspectUrl);
const result = await inspectAndCapture(port, target.webSocketDebuggerUrl, width, height, output, focusOutput, args);
if (!args.keepOpen && target.id) await closeTarget(port, target.id).catch(() => undefined);

const payload = {
  ok: result.verdict.failures.length === 0,
  artifactPath,
  url: inspectUrl.replace(/([?&](?:md64|markdown64)=)[^&]+/, "$1<artifact-markdown>"),
  screenshotPath: output,
  focusScreenshotPath: result.focusCaptured ? focusOutput : undefined,
  stats: result.stats,
  verdict: result.verdict
};
console.log(JSON.stringify(payload, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index++;
    }
  }
  return parsed;
}

function buildInspectUrl(baseUrl, markdown, options) {
  const url = new URL(baseUrl);
  url.searchParams.set("embedded", String(options.embedded || "1"));
  url.searchParams.set("mode", String(options.mode || "light"));
  url.searchParams.set("design", String(options.design || "codex"));
  url.searchParams.set("palette", String(options.palette || "blue"));
  url.searchParams.set("md64", base64Url(markdown));
  if (artifactPath.startsWith(cwd)) {
    const relativeArtifact = artifactPath.slice(cwd.length + 1).replaceAll("\\", "/");
    url.searchParams.set("documentId", relativeArtifact);
    if (relativeArtifact.startsWith("artifacts/")) {
      const dir = relativeArtifact.slice("artifacts/".length).replace(/[^/]+$/, "");
      url.searchParams.set("assetBase", `${apiBase()}/artifacts/${dir}`);
    }
  }
  for (const key of ["section", "heading", "diagram", "image", "part", "focus", "fontSize", "size"]) {
    if (options[key] !== undefined && options[key] !== true) url.searchParams.set(key, String(options[key]));
  }
  return url.toString();
}

function apiBase() {
  return String(process.env.MEETING_API_URL || "http://localhost:4317");
}

function base64Url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function ensureWebServer(cwd, url) {
  if (await isUrlReady(url)) return;
  spawn("pnpm", ["dev:web"], { cwd, detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isUrlReady(url)) return;
    await sleep(300);
  }
  throw new Error(`Meeting web UI did not become ready at ${url}`);
}

async function isUrlReady(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

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
  const created = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT" });
  if (!created.webSocketDebuggerUrl) throw new Error("Could not create browser target");
  return created;
}

async function closeTarget(port, id) {
  const res = await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Could not close browser target ${id}: ${res.status}`);
}

async function inspectAndCapture(_port, wsUrl, w, h, output, focusOutput, options) {
  const cdp = await connectCdp(wsUrl);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.bringToFront");
    await cdp.waitFor("Page.loadEventFired", 10_000).catch(() => undefined);
    await waitForRenderedArtifact(cdp);
    await waitForImages(cdp);
    await sleep(400);

    const stats = await evaluateJson(cdp, `(() => {
      const root = document.querySelector('[data-inspect-root="artifact"]');
      const focus = document.querySelector('.inspectFocus');
      const diagrams = [...document.querySelectorAll('[data-inspect-diagram]')].map((element) => ({
        index: element.getAttribute('data-inspect-diagram'),
        text: (element.textContent || '').trim().slice(0, 200),
        rect: rect(element),
        visibleRatio: visibleRatio(element),
        svg: svgStats(element)
      }));
      const headings = [...document.querySelectorAll('.markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6')].map((element) => ({
        level: element.tagName.toLowerCase(),
        text: (element.textContent || '').trim(),
        rect: rect(element),
        visibleRatio: visibleRatio(element)
      }));
      const images = [...document.querySelectorAll('.markdown img')].map((element) => ({
        src: element.currentSrc || element.src || element.getAttribute('src') || '',
        alt: element.getAttribute('alt') || '',
        complete: element.complete,
        naturalWidth: element.naturalWidth,
        naturalHeight: element.naturalHeight,
        rect: rect(element),
        visibleRatio: visibleRatio(element)
      }));
      function rect(element) {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
      }
      function visibleRatio(element) {
        const r = element.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
        const visibleHeight = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
        const area = Math.max(1, r.width * r.height);
        return Math.max(0, Math.min(1, (visibleWidth * visibleHeight) / area));
      }
      function svgStats(element) {
        const svg = element.querySelector('svg');
        if (!svg) return undefined;
        const text = [...svg.querySelectorAll('text')].map((node) => (node.textContent || '').trim()).filter(Boolean);
        const labels = [...svg.querySelectorAll('.nativeLabel, .nativeArrowLabel')].map((node) => (node.textContent || '').trim()).filter(Boolean);
        const arrows = [...svg.querySelectorAll('.nativeArrow')].map((node) => ({
          text: (node.textContent || '').trim(),
          pathCount: node.querySelectorAll('path, line, polyline').length,
          rect: rect(node)
        }));
        return {
          viewBox: svg.getAttribute('viewBox') || '',
          text,
          labels,
          arrows,
          pathCount: svg.querySelectorAll('path, line, polyline').length,
          shapeCount: svg.querySelectorAll('rect, ellipse, polygon').length,
          width: rect(svg).width,
          height: rect(svg).height
        };
      }
      const bodyText = (root?.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        title: document.querySelector('.markdown h1')?.textContent?.trim() || '',
        rootFound: Boolean(root),
        bodyTextSample: bodyText.slice(0, 2000),
        diagramCount: diagrams.length,
        imageCount: images.length,
        headingCount: headings.length,
        headings,
        diagrams,
        images,
        focus: focus ? { tag: focus.tagName.toLowerCase(), text: (focus.textContent || '').trim().slice(0, 500), rect: rect(focus), visibleRatio: visibleRatio(focus) } : undefined,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      };
    })()`);

    const viewportImage = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, Buffer.from(viewportImage.data, "base64"));

    let focusCaptured = false;
    const focus = stats.focus?.rect;
    if (focus && focus.width > 2 && focus.height > 2) {
      const pad = 24;
      const clip = {
        x: Math.max(0, focus.x - pad),
        y: Math.max(0, focus.y - pad),
        width: Math.min(w, focus.width + pad * 2),
        height: Math.min(h, focus.height + pad * 2),
        scale: 1
      };
      const focusImage = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip });
      await mkdir(dirname(focusOutput), { recursive: true });
      await writeFile(focusOutput, Buffer.from(focusImage.data, "base64"));
      focusCaptured = true;
    }

    const verdict = buildVerdict(stats, options);
    return { stats, focusCaptured, verdict };
  } finally {
    cdp.close();
  }
}

function buildVerdict(stats, options) {
  const failures = [];
  const warnings = [];
  const notes = [];
  if (!stats.rootFound) failures.push("artifact root was not rendered");
  if (!stats.title) warnings.push("artifact has no rendered h1 title");
  for (const image of stats.images || []) {
    if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) failures.push(`image failed to load: ${image.src || image.alt || "unknown image"}`);
    if (image.visibleRatio < 0.25) failures.push(`image is mostly outside the viewport (${Math.round(image.visibleRatio * 100)}% visible): ${image.alt || image.src}`);
  }

  const minDiagrams = numberOption(options.minDiagrams);
  if (minDiagrams !== undefined && stats.diagramCount < minDiagrams) failures.push(`expected at least ${minDiagrams} diagram(s), found ${stats.diagramCount}`);
  if ((options.diagram !== undefined || String(options.focus || "").startsWith("diagram")) && !stats.focus) failures.push("requested diagram focus was not found");
  if ((options.section || options.heading || options.focus || options.diagram !== undefined) && !stats.focus) failures.push("requested focus target was not found");
  if (stats.focus && stats.focus.visibleRatio < 0.25) failures.push(`focused target is mostly outside the viewport (${Math.round(stats.focus.visibleRatio * 100)}% visible)`);

  for (const expected of listOption(options.expectText)) {
    if (!containsText(stats.bodyTextSample, expected)) failures.push(`expected text not visible in artifact text sample: ${expected}`);
  }

  for (const expected of listOption(options.expectDiagramText)) {
    const found = stats.diagrams.some((diagram) => containsText([diagram.text, ...(diagram.svg?.text || []), ...(diagram.svg?.labels || [])].join(" "), expected));
    if (!found) failures.push(`expected diagram text not found: ${expected}`);
  }

  for (const diagram of stats.diagrams) {
    if (!diagram.svg) warnings.push(`diagram ${diagram.index} did not render as SVG`);
    else {
      if (diagram.svg.width < 120 || diagram.svg.height < 120) failures.push(`diagram ${diagram.index} rendered too small (${Math.round(diagram.svg.width)}x${Math.round(diagram.svg.height)})`);
      if (diagram.svg.pathCount < 1) failures.push(`diagram ${diagram.index} has no visible paths/connectors`);
      if (diagram.svg.text.length < 1) warnings.push(`diagram ${diagram.index} has no SVG text labels`);
      notes.push(`diagram ${diagram.index}: ${diagram.svg.text.length} text labels, ${diagram.svg.pathCount} paths, ${diagram.svg.arrows.length} arrow groups`);
    }
  }

  return {
    status: failures.length ? "fail" : warnings.length ? "warn" : "pass",
    failures,
    warnings,
    notes
  };
}

function numberOption(value) {
  if (value === undefined || value === true) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function listOption(value) {
  if (value === undefined || value === true) return [];
  return String(value).split("|").map((item) => item.trim()).filter(Boolean);
}

function containsText(haystack, needle) {
  return normalizeText(haystack).includes(normalizeText(needle));
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function waitForRenderedArtifact(cdp) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const ready = await evaluateJson(cdp, `Boolean(document.querySelector('[data-inspect-root="artifact"]') && (document.querySelector('.markdown h1, .markdown h2, [data-inspect-diagram]')))`);
    if (ready) return;
    await sleep(250);
  }
  throw new Error("Rendered artifact did not appear in the browser");
}

async function waitForImages(cdp) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const ready = await evaluateJson(cdp, `(() => {
      const images = [...document.querySelectorAll('.markdown img')];
      return images.every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    })()`);
    if (ready) return;
    await sleep(250);
  }
}

async function evaluateJson(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result.value;
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
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
