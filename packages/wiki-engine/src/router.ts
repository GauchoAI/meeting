import { spawn } from "node:child_process";
import type { CandidateScore, ExtractedSource, RouteDecision, WikiPage } from "./types.js";

export interface RouterOptions {
  useLlm?: boolean;
  llmCommand?: string;
  timeoutMs?: number;
}

export async function decideParent(
  source: ExtractedSource,
  candidates: CandidateScore[],
  options: RouterOptions = {}
): Promise<RouteDecision> {
  if (options.useLlm) {
    const llm = await tryLlmDecision(source, candidates, options);
    if (llm) {
      return llm;
    }
  }
  const best = candidates[0];
  const parentId = best?.node.frontmatter.id ?? "wiki://root";
  return {
    parentId,
    confidence: Math.min(0.95, Math.max(0.35, (best?.score ?? 0.5) / 12)),
    reasons: best?.reasons.length ? best.reasons : ["deterministic-fallback"],
    usedLlm: false
  };
}

async function tryLlmDecision(
  source: ExtractedSource,
  candidates: CandidateScore[],
  options: RouterOptions
): Promise<RouteDecision | undefined> {
  const command = options.llmCommand ?? "pi";
  const menu = candidates.map((candidate, index) => ({
    n: index + 1,
    id: candidate.node.frontmatter.id,
    title: candidate.node.frontmatter.title,
    keywords: candidate.node.frontmatter.keywords,
    score: candidate.score,
    reasons: candidate.reasons
  }));
  const prompt = [
    "Choose the best parent wiki page for this new source.",
    "Return only compact JSON with keys: n, confidence, reason.",
    "",
    `SOURCE: ${JSON.stringify({
      title: source.title,
      summary: source.summary,
      keywords: source.keywords,
      pathHints: source.pathHints,
      sourcePath: source.sourcePath
    })}`,
    "",
    `CANDIDATES: ${JSON.stringify(menu)}`
  ].join("\n");
  try {
    const stdout = await runCommand(command, ["--no-session", "-p", prompt], options.timeoutMs ?? 30_000);
    const parsed = JSON.parse(extractJson(stdout)) as { n?: number; confidence?: number; reason?: string };
    const index = Math.max(0, (parsed.n ?? 1) - 1);
    const candidate = candidates[index];
    if (!candidate) {
      return undefined;
    }
    return {
      parentId: candidate.node.frontmatter.id,
      confidence: clamp(parsed.confidence ?? 0.75),
      reasons: [`llm:${parsed.reason ?? "selected candidate"}`, ...candidate.reasons],
      usedLlm: true
    };
  } catch {
    return undefined;
  }
}

async function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `${command} exited ${code}`));
      }
    });
  });
}

function extractJson(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not include JSON");
  }
  return value.slice(start, end + 1);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
