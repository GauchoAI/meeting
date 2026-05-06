import type { WikiFrontmatter, WikiPage } from "./types.js";

export function parsePage(filePath: string, text: string): WikiPage {
  if (!text.startsWith("---\n")) {
    throw new Error(`${filePath} is missing wiki frontmatter`);
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error(`${filePath} has unterminated wiki frontmatter`);
  }
  const raw = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n/, "");
  const data: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    data[key] = parseValue(value);
  }
  return {
    path: filePath,
    frontmatter: data as unknown as WikiFrontmatter,
    body
  };
}

export function formatPage(page: WikiPage): string {
  const entries = Object.entries(page.frontmatter).filter(([, value]) => value !== undefined);
  const yaml = entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join("\n");
  return `---\n${yaml}\n---\n\n${page.body.trim()}\n`;
}

function parseValue(value: string): unknown {
  if (value === "null") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}
