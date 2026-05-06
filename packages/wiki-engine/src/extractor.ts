import path from "node:path";
import type { ExtractedSource, WikiWorkspace } from "./types.js";
import { checksum, repoRelative, slugify, tokenize, uniqueValues } from "./utils.js";

export function extractSource(workspace: WikiWorkspace, filePath: string, content: string): ExtractedSource {
  const relative = repoRelative(workspace.rootDir, filePath);
  const title = titleFromContent(filePath, content);
  const tokens = tokenize(`${title}\n${relative}\n${content}`).filter((token) => !genericTokens.has(token));
  const pathHints = uniqueValues(
    relative
      .split("/")
      .slice(0, -1)
      .flatMap((segment) => tokenize(segment))
      .filter((token) => !genericTokens.has(token))
  );
  const keywords = uniqueValues([...pathHints, ...tokens]).slice(0, 16);
  const entities = uniqueValues(
    content.match(/\b[A-Z][A-Za-z0-9-]{2,}(?:\s+[A-Z][A-Za-z0-9-]{2,}){0,3}\b/g) ?? []
  ).slice(0, 12);
  return {
    id: `source://${slugify(relative.replace(/\.[^.]+$/, ""))}`,
    sourcePath: relative,
    title,
    summary: summarize(content),
    keywords,
    entities,
    pathHints,
    checksum: checksum(content),
    contentPreview: content.replace(/\s+/g, " ").trim().slice(0, 700)
  };
}

const genericTokens = new Set(["raw", "source", "sources", "files", "file", "markdown"]);

function titleFromContent(filePath: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) {
    return heading;
  }
  return path.basename(filePath).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

function summarize(content: string): string {
  const normalized = content
    .replace(/^---[\s\S]*?---/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = normalized.match(/[^.!?]+[.!?]/)?.[0]?.trim();
  return (sentence || normalized).slice(0, 240) || "No textual summary available.";
}
