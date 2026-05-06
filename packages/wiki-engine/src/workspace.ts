import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type { WikiPage, WikiWorkspace } from "./types.js";
import { formatPage } from "./frontmatter.js";
import { nowIso, writeText } from "./utils.js";

export function createWorkspace(rootDir: string): WikiWorkspace {
  return {
    rootDir,
    rawDir: path.join(rootDir, "raw"),
    wikiDir: path.join(rootDir, "wiki"),
    stateDir: path.join(rootDir, ".wiki-state"),
    queuePath: path.join(rootDir, ".wiki-state", "queue.json")
  };
}

export async function ensureWorkspace(workspace: WikiWorkspace): Promise<void> {
  await mkdir(workspace.rawDir, { recursive: true });
  await mkdir(workspace.wikiDir, { recursive: true });
  await mkdir(workspace.stateDir, { recursive: true });
  await ensureRootPage(workspace);
}

export async function ensureRootPage(workspace: WikiWorkspace): Promise<void> {
  try {
    await access(path.join(workspace.wikiDir, "root.md"));
    return;
  } catch {
    // Create the root page below.
  }
  const createdAt = nowIso();
  const page: WikiPage = {
    path: path.join(workspace.wikiDir, "root.md"),
    frontmatter: {
      id: "wiki://root",
      title: "Root",
      kind: "root",
      parent: null,
      children: ["wiki://project", "wiki://research"],
      keywords: ["root", "index"],
      references: [],
      confidence: 1,
      createdAt,
      updatedAt: createdAt
    },
    body: [
      "# Root",
      "",
      "Canonical entry point for menu-assisted wiki traversal.",
      "",
      "## Children",
      "",
      "[1] Project -> wiki://project",
      "[2] Research -> wiki://research",
      "",
      "## Notes",
      "",
      "New pages attach here only when no better parent is available."
    ].join("\n")
  };
  await writeText(page.path, formatPage(page));
  await writeText(path.join(workspace.wikiDir, "project.md"), formatPage(patternPage("wiki://project", "Project", ["project", "meeting", "ui", "speech", "mcp", "agent"], createdAt)));
  await writeText(path.join(workspace.wikiDir, "research.md"), formatPage(patternPage("wiki://research", "Research", ["research", "experiment", "training", "model", "benchmark", "chess", "wiki"], createdAt)));
}

function patternPage(id: string, title: string, keywords: string[], createdAt: string): WikiPage {
  return {
    path: "",
    frontmatter: {
      id,
      title,
      kind: "pattern",
      parent: "wiki://root",
      children: [],
      keywords,
      references: [],
      confidence: 1,
      createdAt,
      updatedAt: createdAt
    },
    body: [
      `# ${title}`,
      "",
      "Pattern page used by the wiki router for structural placement.",
      "",
      "## Children",
      "",
      "_No children yet._",
      "",
      "## Notes",
      "",
      "Children are inserted here when extracted signals match this pattern."
    ].join("\n")
  };
}
