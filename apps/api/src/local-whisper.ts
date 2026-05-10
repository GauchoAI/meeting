import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

export interface LocalWhisperResult {
  text: string;
  provider: "local-whisper";
  modelPath: string;
  elapsedMs: number;
}

export async function transcribeWithLocalWhisper(input: Buffer, extension: string): Promise<LocalWhisperResult> {
  const serverUrl = process.env.WHISPER_SERVER_URL;
  if (serverUrl) {
    try {
      return await transcribeWithWhisperServer(input, extension, serverUrl);
    } catch (error) {
      if (process.env.WHISPER_SERVER_FALLBACK_CLI === "false") throw error;
      console.warn(`[meeting-api] Whisper server failed; falling back to whisper-cli: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return transcribeWithWhisperCli(input, extension);
}

async function transcribeWithWhisperServer(input: Buffer, extension: string, serverUrl: string): Promise<LocalWhisperResult> {
  const started = Date.now();
  const modelPath = resolveRepoPath(process.env.WHISPER_MODEL_PATH || "models/ggml-small.bin");
  const endpoint = whisperServerInferenceUrl(serverUrl);
  const form = new FormData();
  const arrayBuffer = new ArrayBuffer(input.byteLength);
  new Uint8Array(arrayBuffer).set(input);
  form.set("file", new Blob([arrayBuffer], { type: mimeTypeForExtension(extension) }), `chunk.${extension || "webm"}`);
  form.set("response_format", "json");
  form.set("temperature", "0");
  form.set("language", process.env.WHISPER_LANGUAGE || "en");
  const response = await fetch(endpoint, { method: "POST", body: form });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`whisper-server ${response.status}: ${body.slice(-1000)}`);
  }
  return { text: parseWhisperServerText(body), provider: "local-whisper", modelPath, elapsedMs: Date.now() - started };
}

async function transcribeWithWhisperCli(input: Buffer, extension: string): Promise<LocalWhisperResult> {
  const started = Date.now();
  const bin = process.env.WHISPER_CPP_BIN || "whisper-cli";
  const modelPath = resolveRepoPath(process.env.WHISPER_MODEL_PATH || "models/ggml-small.bin");
  const dir = mkdtempSync(join(tmpdir(), "meeting-whisper-"));
  const source = join(dir, `chunk.${extension || "webm"}`);
  const wav = join(dir, "chunk.wav");
  const out = join(dir, "transcript");
  try {
    writeFileSync(source, input);
    await run("ffmpeg", ["-y", "-i", source, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    await run(bin, ["-m", modelPath, "-f", wav, "-otxt", "-of", out, "-np"]);
    const text = readFileSync(`${out}.txt`, "utf8").trim();
    return { text, provider: "local-whisper", modelPath, elapsedMs: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function whisperServerInferenceUrl(serverUrl: string): string {
  const normalized = serverUrl.replace(/\/+$/, "");
  return normalized.endsWith("/inference") ? normalized : `${normalized}/inference`;
}

function mimeTypeForExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === "mp4" || normalized === "m4a") return "audio/mp4";
  if (normalized === "wav") return "audio/wav";
  if (normalized === "aiff" || normalized === "aif") return "audio/aiff";
  return "audio/webm";
}

function parseWhisperServerText(body: string): string {
  try {
    const payload = JSON.parse(body) as { text?: unknown; segments?: Array<{ text?: unknown }> };
    if (typeof payload.text === "string") return payload.text.trim();
    if (Array.isArray(payload.segments)) {
      return payload.segments.map((segment) => typeof segment.text === "string" ? segment.text : "").join(" ").trim();
    }
  } catch {
    // Some whisper.cpp builds can return plain text if response_format is ignored.
  }
  return body.trim();
}

function resolveRepoPath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  const cwd = process.cwd();
  if (cwd.endsWith("/apps/api")) {
    return resolve(cwd, "../..", path);
  }
  return resolve(cwd, path);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}
