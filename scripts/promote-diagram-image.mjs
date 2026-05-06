#!/usr/bin/env node
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const cwd = resolve(args.cwd || process.cwd());
const artifactPath = resolvePath(requireArg("artifact"));
const imagePath = resolvePath(requireArg("image"));
const diagramIndex = numberArg("diagram", 0);
const section = clean(args.section || "");
const alt = clean(args.alt || "Generated diagram repair");
const prompt = args.prompt ? String(args.prompt) : "";

await assertFile(artifactPath);
await assertFile(imagePath);

const artifactMarkdown = await readFile(artifactPath, "utf8");
const artifactDir = dirname(artifactPath);
const base = basename(artifactPath, extname(artifactPath));
const suffix = [
  section ? `section-${slugify(section)}` : undefined,
  `diagram-${diagramIndex}`,
  "image-fix"
].filter(Boolean).join(".");
const imageExt = extname(imagePath).toLowerCase() || ".png";
const imageName = `${base}.${suffix}${imageExt}`;
const promptName = `${base}.${suffix}.prompt.md`;
const sourceName = `${base}.${suffix}.source.md`;
const targetImagePath = resolve(artifactDir, imageName);
const targetPromptPath = resolve(artifactDir, promptName);
const targetSourcePath = resolve(artifactDir, sourceName);

const block = findDiagramBlock(artifactMarkdown, diagramIndex);
const originalBlock = artifactMarkdown.slice(block.start, block.end);
const imageMarkdown = [
  `![${alt}](./${imageName})`,
  "",
  `<!-- generated-diagram-image: section=${section || "unknown"} diagram=${diagramIndex} prompt=./${promptName} source=./${sourceName} -->`
].join("\n");
const nextMarkdown = `${artifactMarkdown.slice(0, block.start)}${imageMarkdown}${artifactMarkdown.slice(block.end)}`;

await mkdir(artifactDir, { recursive: true });
await copyFile(imagePath, targetImagePath);
await writeFile(targetPromptPath, `${prompt || defaultPrompt()}\n`);
await writeFile(targetSourcePath, `${originalBlock.endsWith("\n") ? originalBlock : `${originalBlock}\n`}`);
await writeFile(artifactPath, nextMarkdown.endsWith("\n") ? nextMarkdown : `${nextMarkdown}\n`);

console.log(JSON.stringify({
  artifactPath: relative(cwd, artifactPath),
  imagePath: relative(cwd, targetImagePath),
  promptPath: relative(cwd, targetPromptPath),
  sourcePath: relative(cwd, targetSourcePath),
  diagramIndex,
  section
}, null, 2));

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

function requireArg(name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing --${name}`);
  return value;
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function assertFile(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Not a file: ${path}`);
}

function numberArg(name, fallback) {
  const value = args[name];
  if (value === undefined || value === true) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function findDiagramBlock(markdown, targetIndex) {
  const lines = markdown.split(/(?<=\n)/);
  let offset = 0;
  let diagramCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = openingFence(line);
    if (!fence) {
      offset += line.length;
      continue;
    }
    const start = offset;
    offset += line.length;
    let end = offset;
    for (index = index + 1; index < lines.length; index++) {
      const current = lines[index];
      end += current.length;
      if (current.trim().startsWith("```")) break;
    }
    if (fence === "diagram") {
      if (diagramCount === targetIndex) return { start, end };
      diagramCount++;
    }
    offset = end;
  }
  throw new Error(`Diagram block ${targetIndex} not found`);
}

function openingFence(line) {
  const trimmed = line.trim().toLowerCase();
  if (!trimmed.startsWith("```")) return undefined;
  const info = trimmed.slice(3).trim();
  return ["excalidraw", "excalidraw-json", "excalidraw.json", "diagram", "native-diagram"].includes(info) ? "diagram" : "other";
}

function clean(value) {
  return String(value || "").trim();
}

function slugify(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function defaultPrompt() {
  return [
    "Edit the referenced diagram image as a minimal pixel-level repair.",
    "",
    "Do not redraw the diagram. Do not restyle it. Do not improve the design. Do not change layout, spacing, colors, handwriting style, stroke texture, node shapes, node positions, labels, or arrow meanings.",
    "",
    "When repairing connector defects, make arrows begin and end on the visible contour of their source/target shapes. Avoid arrow strokes passing through boxes, circles, or labels unless the existing diagram makes that unavoidable.",
    "",
    "Keep arrow labels readable and detached from boxes: labels should not overlap nodes, node labels, arrowheads, or other arrow labels.",
    "",
    "Only repair visible defects that make the existing diagram incorrect or hard to read, using the smallest local edits possible. Preserve all unaffected pixels as close to unchanged as possible.",
    "",
    "If a defect can be fixed by moving or cleaning a small local element, do only that. Leave the rest of the image identical."
  ].join("\n");
}
