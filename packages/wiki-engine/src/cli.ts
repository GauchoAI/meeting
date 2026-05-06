import { mkdir, stat, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { enqueueFile, readQueue } from "./queue.js";
import { drainQueue } from "./processor.js";
import { runScenario } from "./scenario.js";
import { recordAttention } from "./state.js";
import { createWorkspace, ensureWorkspace } from "./workspace.js";
import { findPage, loadPages, searchPages } from "./wiki.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const flags = parseFlags(args);

  if (command === "scenario") {
    const output = await runScenario({
      rootDir: flags.root,
      useLlm: flags.llm === "pi" || flags.llm === "true",
      llmCommand: flags.llmCommand,
      timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined,
      step: flags.step !== "false"
    });
    console.log(output);
    return;
  }

  if (command === "init") {
    const workspace = createWorkspace(required(flags.root, "--root"));
    await ensureWorkspace(workspace);
    console.log(`Initialized wiki workspace at ${workspace.rootDir}`);
    return;
  }

  if (command === "add") {
    const workspace = await openWorkspace(flags);
    const file = required(flags.file, "--file");
    await mkdir(path.dirname(file), { recursive: true });
    if (flags.text) {
      await writeFile(file, flags.text, "utf8");
    }
    const item = await enqueueFile(workspace, file);
    console.log(JSON.stringify(item, null, 2));
    return;
  }

  if (command === "process") {
    const workspace = await openWorkspace(flags);
    const results = await drainQueue(workspace, {
      useLlm: flags.llm === "pi" || flags.llm === "true",
      llmCommand: flags.llmCommand,
      timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined
    });
    console.log(`Processed ${results.length} item(s).`);
    for (const result of results) {
      console.log(`${result.extracted.title} -> ${result.decision.parentId} -> ${result.page.frontmatter.id}`);
    }
    return;
  }

  if (command === "queue") {
    const workspace = await openWorkspace(flags);
    console.log(JSON.stringify(await readQueue(workspace), null, 2));
    return;
  }

  if (command === "search") {
    const workspace = await openWorkspace(flags);
    const query = required(flags.query, "--query");
    const pages = await loadPages(workspace);
    const results = searchPages(query, pages).slice(0, Number(flags.limit ?? 5));
    for (const result of results) {
      await recordAttention(workspace, result.page.frontmatter.id, "search", `matched query "${query}"`);
      console.log(`${result.score.toString().padStart(3)} ${result.page.frontmatter.id} ${result.page.frontmatter.title}`);
      for (const ref of result.references) {
        console.log(`    ${ref.label} ${ref.kind} ${ref.targetTitle} -> ${ref.targetId}`);
      }
    }
    return;
  }

  if (command === "watch") {
    const workspace = await openWorkspace(flags);
    const input = flags.input ?? workspace.rawDir;
    await mkdir(input, { recursive: true });
    console.log(`Watching ${input}`);
    watch(input, { recursive: true }, async (_event, fileName) => {
      if (!fileName || !fileName.endsWith(".md")) {
        return;
      }
      const file = path.join(input, fileName);
      try {
        if (!(await stat(file)).isFile()) {
          return;
        }
        const item = await enqueueFile(workspace, file);
        console.log(`queued ${item.id} ${path.relative(workspace.rootDir, file)}`);
        const results = await drainQueue(workspace, {
          useLlm: flags.llm === "pi" || flags.llm === "true",
          llmCommand: flags.llmCommand,
          timeoutMs: flags.timeoutMs ? Number(flags.timeoutMs) : undefined
        });
        for (const result of results) {
          console.log(`processed ${result.extracted.title} -> ${result.decision.parentId}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
      }
    });
    await new Promise(() => undefined);
    return;
  }

  if (command === "open") {
    const workspace = await openWorkspace(flags);
    const page = await findPage(workspace, required(flags.id, "--id"));
    console.log(page.body);
    return;
  }

  printHelp();
}

function parseFlags(args: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      continue;
    }
    const [rawKey, rawValue] = arg.slice(2).split("=", 2);
    flags[toCamel(rawKey)] = rawValue ?? args[index + 1] ?? "true";
    if (rawValue === undefined && args[index + 1] && !args[index + 1].startsWith("--")) {
      index += 1;
    }
  }
  return flags;
}

async function openWorkspace(flags: Record<string, string | undefined>) {
  const workspace = createWorkspace(required(flags.root, "--root"));
  await ensureWorkspace(workspace);
  return workspace;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function toCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function printHelp(): void {
  console.log([
    "meeting wiki engine",
    "",
    "Commands:",
    "  scenario [--llm pi] [--timeout-ms 30000] [--root DIR]",
    "  init --root DIR",
    "  add --root DIR --file FILE [--text TEXT]",
    "  process --root DIR [--llm pi]",
    "  watch --root DIR [--input DIR] [--llm pi]",
    "  queue --root DIR",
    "  search --root DIR --query TEXT [--limit N]",
    "  open --root DIR --id wiki://root"
  ].join("\n"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
