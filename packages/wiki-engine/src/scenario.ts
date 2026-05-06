import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RouterOptions } from "./router.js";
import type { WikiWorkspace } from "./types.js";
import { enqueueFile, readQueue } from "./queue.js";
import { drainQueue, processNext } from "./processor.js";
import { readAttention, recordAttention } from "./state.js";
import { createWorkspace, ensureWorkspace } from "./workspace.js";
import { loadPages, searchPages } from "./wiki.js";

export interface ScenarioOptions extends RouterOptions {
  rootDir?: string;
  step?: boolean;
}

interface ScenarioFile {
  relativePath: string;
  content: string;
}

const scenarioFiles: ScenarioFile[] = [
  {
    relativePath: "raw/project/meeting-overview.md",
    content: [
      "# Meeting Project Overview",
      "",
      "The meeting project is a local-first collaboration room for humans and coding agents.",
      "It combines local speech transcription, MCP tools, Markdown rendering, Mermaid diagrams, and repository context.",
      "Agents can raise a hand, post visual explanations, and use the UI as a mute but expressive collaboration surface."
    ].join("\n")
  },
  {
    relativePath: "raw/project/mcp-tools.md",
    content: [
      "# Meeting MCP Tools",
      "",
      "The MCP layer exposes meeting_raise_hand, meeting_post_markdown, meeting_set_repository, and meeting_create_task.",
      "These tools let Codex, Claude, and local agents communicate with the meeting UI through structured events.",
      "The tools belong under the meeting project because they are the control surface for agent collaboration."
    ].join("\n")
  },
  {
    relativePath: "raw/research/chess-training.md",
    content: [
      "# Chess Training Results",
      "",
      "The chess experiment trains compact policy models from tactics, motifs, and self-play traces.",
      "The best checkpoint became the default online champion after improving the KPI through broader puzzles and adversarial evaluation.",
      "This belongs under research because it records model training progress and benchmark evidence."
    ].join("\n")
  },
  {
    relativePath: "raw/project/speech-whisper.md",
    content: [
      "# Local Whisper Speech",
      "",
      "The meeting UI uses local Whisper transcription for low-cost bilingual speech capture.",
      "Speech events feed the transcript and let agents react without hosting a permanent speech service.",
      "This belongs near the meeting project because it is part of the live room interface."
    ].join("\n")
  },
  {
    relativePath: "raw/research/wiki-memory.md",
    content: [
      "# Wiki Memory Engine",
      "",
      "The wiki memory engine watches files, queues them, extracts keywords, routes them through the existing wiki graph, and backtracks child links into parent pages.",
      "It uses numbered references so agents can traverse knowledge like a menu-assisted call instead of scanning raw embeddings.",
      "This belongs under research and meeting because it is both an experiment and a tool for agent memory."
    ].join("\n")
  }
];

export async function runScenario(options: ScenarioOptions = {}): Promise<string> {
  const rootDir = options.rootDir ?? (await mkdtemp(path.join(os.tmpdir(), "meeting-wiki-scenario-")));
  const workspace = createWorkspace(rootDir);
  await ensureWorkspace(workspace);
  const lines: string[] = [
    `Scenario workspace: ${workspace.rootDir}`,
    `LLM router: ${options.useLlm ? "enabled" : "disabled"}`
  ];

  for (const file of scenarioFiles) {
    const fullPath = path.join(rootDir, file.relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, "utf8");
    const item = await enqueueFile(workspace, fullPath);
    lines.push("");
    lines.push(`STEP enqueue ${file.relativePath}`);
    lines.push(`  queue item: ${item.id} ${item.status}`);

    const result = options.step === false
      ? undefined
      : await processNext(workspace, options);
    if (result) {
      lines.push(...formatProcessStep(result));
    }
  }

  if (options.step === false) {
    const results = await drainQueue(workspace, options);
    for (const result of results) {
      lines.push(...formatProcessStep(result));
    }
  }

  const queue = await readQueue(workspace);
  const pages = await loadPages(workspace);
  lines.push("");
  lines.push("FINAL queue");
  for (const item of queue) {
    lines.push(`  ${item.status.padEnd(6)} ${path.basename(item.path)} -> ${item.resultNodeId ?? "none"}`);
  }

  lines.push("");
  lines.push("FINAL wiki pages");
  for (const page of pages.sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id))) {
    lines.push(`  ${page.frontmatter.id} parent=${page.frontmatter.parent ?? "none"} children=${page.frontmatter.children.length}`);
  }

  lines.push("");
  lines.push("SEARCH showcases");
  lines.push(...(await formatSearch(workspace, "meeting agent tools")));
  lines.push(...(await formatSearch(workspace, "chess benchmark model")));
  lines.push(...(await formatSearch(workspace, "wiki traversal references")));

  lines.push("");
  lines.push("FINAL attention index");
  const attention = await readAttention(workspace);
  for (const entry of Object.values(attention.entries).sort((a, b) => b.visits - a.visits)) {
    lines.push(`  ${entry.pageId} visits=${entry.visits} insertions=${entry.insertions} searches=${entry.searches}`);
  }

  return lines.join("\n");
}

function formatProcessStep(result: Awaited<ReturnType<typeof processNext>>): string[] {
  if (!result) {
    return [];
  }
  return [
    `  extracted: ${result.extracted.title}`,
    `  parent: ${result.decision.parentId} confidence=${result.decision.confidence.toFixed(2)} llm=${result.decision.usedLlm}`,
    `  reasons: ${result.decision.reasons.join(", ")}`,
    `  wrote: ${result.page.frontmatter.id}`,
    `  backtracked child into: ${result.updatedParent.frontmatter.id}`
  ];
}

async function formatSearch(workspace: WikiWorkspace, query: string): Promise<string[]> {
  const pages = await loadPages(workspace);
  const results = searchPages(query, pages).slice(0, 3);
  const lines = [`  query: "${query}"`];
  if (results.length === 0) {
    lines.push("    no results");
    return lines;
  }
  for (const result of results) {
    await recordAttention(workspace, result.page.frontmatter.id, "search", `scenario query "${query}"`);
    const refs = result.references.map((ref) => `${ref.label} ${ref.targetTitle}`).join("; ") || "no menu refs";
    lines.push(`    score=${result.score} ${result.page.frontmatter.title} (${result.page.frontmatter.id})`);
    lines.push(`      refs: ${refs}`);
  }
  return lines;
}
