#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
const artifactsRoot = resolve(root, "artifacts");
const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const knownKinds = new Set(["diagram", "plan", "implementation", "status", "note", "spec", "decision"]);

if (command === "write") await writeArtifact();
else if (command === "list") await listArtifacts();
else if (command === "find") await findArtifacts();
else if (command === "index") await indexArtifacts();
else if (command === "url") await artifactUrl();
else usage(1);

async function writeArtifact() {
  const kind = slugify(requireArg("kind"));
  if (!knownKinds.has(kind) && args.strict) throw new Error(`Unknown kind '${kind}'. Known: ${[...knownKinds].join(", ")}`);
  const slug = slugify(requireArg("slug"));
  const title = args.title || titleize(slug);
  const now = new Date();
  const sourcePath = args.file ? resolve(root, args.file) : undefined;
  const body = sourcePath ? await readFile(sourcePath, "utf8") : args.body;
  if (!body) throw new Error("write requires --file <path> or --body <markdown>");

  const dir = args.path ? resolve(root, args.path) : await findOrCreateArtifactDir(kind, slug, now);
  await mkdir(dir, { recursive: true });
  const artifactPath = join(dir, "artifact.smart.md");
  const manifestPath = join(dir, "manifest.json");
  let existing = {};
  try { existing = JSON.parse(await readFile(manifestPath, "utf8")); } catch {}
  const createdAt = existing.createdAt || now.toISOString();
  const manifest = normalizeManifest({
    kind,
    slug,
    title,
    createdAt,
    updatedAt: now.toISOString(),
    artifact: "artifact.smart.md",
    tags: parseTags(args.tags || existing.tags || []),
    summary: args.summary || existing.summary || "",
  }, manifestPath);
  await writeFile(artifactPath, body.endsWith("\n") ? body : `${body}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await indexArtifacts({ quiet: true });
  console.log(relative(root, artifactPath));
}

async function listArtifacts() {
  const records = await artifactRecords();
  for (const record of records.sort(byUpdatedDesc)) {
    console.log(`${record.path}\t${record.kind}\t${record.slug}\t${record.title}\t${record.tags.join(",")}`);
  }
}

async function findArtifacts() {
  const query = String(args.q || args.query || process.argv[3] || "").toLowerCase();
  const kind = args.kind ? slugify(args.kind) : "";
  const tag = args.tag ? slugify(args.tag) : "";
  const records = await artifactRecords();
  const matches = records.filter((record) => {
    if (kind && record.kind !== kind) return false;
    if (tag && !record.tags.includes(tag)) return false;
    if (!query) return true;
    return [record.slug, record.title, record.summary, record.kind, record.path, ...record.tags].join(" ").toLowerCase().includes(query);
  });
  for (const record of matches.sort(byUpdatedDesc)) {
    console.log(`${record.path}\t${record.kind}\t${record.slug}\t${record.title}`);
  }
}

async function indexArtifacts(options = {}) {
  const records = (await artifactRecords()).sort(byUpdatedDesc);
  const indexPath = join(artifactsRoot, "index.json");
  await mkdir(artifactsRoot, { recursive: true });
  await writeFile(indexPath, `${JSON.stringify({ updatedAt: new Date().toISOString(), artifacts: records }, null, 2)}\n`);
  if (!options.quiet) console.log(relative(root, indexPath));
}

async function artifactUrl() {
  const file = process.argv[3];
  if (!file) usage(1);
  const markdown = await readFile(resolve(root, file), "utf8");
  const encoded = Buffer.from(markdown, "utf8").toString("base64url");
  console.log(`http://localhost:5174/?md64=${encoded}`);
}

async function artifactRecords() {
  const manifests = await findFiles(artifactsRoot, "manifest.json");
  const records = [];
  for (const manifestPath of manifests) {
    try {
      const manifest = normalizeManifest(JSON.parse(await readFile(manifestPath, "utf8")), manifestPath);
      const artifactPath = join(dirname(manifestPath), manifest.artifact || "artifact.smart.md");
      const info = await stat(artifactPath);
      records.push({
        ...manifest,
        path: relative(root, artifactPath),
        dir: relative(root, dirname(manifestPath)),
        mtime: info.mtime.toISOString(),
      });
    } catch {}
  }
  return records;
}

async function findOrCreateArtifactDir(kind, slug, now) {
  const existing = await findMatchingArtifactDir(kind, slug);
  if (existing) return existing;
  const dt = now.toISOString().slice(0, 10);
  const hour = String(now.getHours()).padStart(2, "0");
  return join(artifactsRoot, `dt=${dt}`, `hour=${hour}`, `${kind}-${slug}`);
}

async function findMatchingArtifactDir(kind, slug) {
  const manifests = await findFiles(artifactsRoot, "manifest.json").catch(() => []);
  for (const manifestPath of manifests) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest.kind === kind && manifest.slug === slug) return dirname(manifestPath);
    } catch {}
  }
  return undefined;
}

async function findFiles(dir, name) {
  const out = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else if (entry === name) out.push(path);
    }
  }
  await walk(dir);
  return out;
}

function normalizeManifest(manifest, manifestPath) {
  const dir = dirname(manifestPath);
  const folder = dir.split(/[\\/]/).pop() || "artifact";
  const inferredKind = folder.includes("-") ? folder.split("-")[0] : "note";
  const inferredSlug = folder.includes("-") ? folder.split("-").slice(1).join("-") : folder;
  return {
    kind: slugify(manifest.kind || inferredKind),
    slug: slugify(manifest.slug || inferredSlug),
    title: manifest.title || titleize(manifest.slug || inferredSlug),
    createdAt: manifest.createdAt || manifest.updatedAt || new Date(0).toISOString(),
    updatedAt: manifest.updatedAt || manifest.createdAt || new Date(0).toISOString(),
    artifact: manifest.artifact || "artifact.smart.md",
    tags: parseTags(manifest.tags || []),
    summary: manifest.summary || "",
  };
}

function byUpdatedDesc(a, b) {
  return String(b.updatedAt).localeCompare(String(a.updatedAt));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const eq = item.indexOf("=");
    if (eq !== -1) parsed[item.slice(2, eq)] = item.slice(eq + 1);
    else parsed[item.slice(2)] = argv[++i] ?? "";
  }
  return parsed;
}

function requireArg(name) {
  if (!args[name]) throw new Error(`Missing --${name}`);
  return args[name];
}

function parseTags(value) {
  if (Array.isArray(value)) return value.map(slugify).filter(Boolean);
  return String(value || "").split(",").map((tag) => slugify(tag.trim())).filter(Boolean);
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleize(value) {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function usage(code = 0) {
  console.error(`Usage:
  node scripts/smart-artifact.mjs write --kind <kind> --slug <slug> --title <title> [--tags a,b] [--summary text] (--file path | --body markdown)
  node scripts/smart-artifact.mjs list
  node scripts/smart-artifact.mjs find [query] [--kind kind] [--tag tag]
  node scripts/smart-artifact.mjs index
  node scripts/smart-artifact.mjs url <artifact.smart.md>`);
  process.exit(code);
}
