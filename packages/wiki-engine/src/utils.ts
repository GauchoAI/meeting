import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export function wikiIdFromTitle(title: string): string {
  return `wiki://${slugify(title)}`;
}

export function pageFileName(id: string): string {
  return `${id.replace(/^wiki:\/\//, "").replace(/[^a-z0-9-]/g, "-")}.md`;
}

export function uniqueValues(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

export async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

export function repoRelative(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).replaceAll(path.sep, "/");
}

export function tokenize(value: string): string[] {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "be",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "with"
  ]);
  return uniqueValues(
    value
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g)
      ?.filter((token) => !stop.has(token)) ?? []
  );
}
