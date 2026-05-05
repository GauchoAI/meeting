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
