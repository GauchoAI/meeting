import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AttentionIndex, CandidateScore, ExtractedSource, TraversalReference, WikiPage, WikiWorkspace } from "./types.js";
import { attentionBoost } from "./state.js";
import { formatPage, parsePage } from "./frontmatter.js";
import { pageFileName, readText, tokenize, uniqueValues, wikiIdFromTitle, writeText, nowIso } from "./utils.js";

export async function loadPages(workspace: WikiWorkspace): Promise<WikiPage[]> {
  const names = await readdir(workspace.wikiDir);
  const pages: WikiPage[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".md")).sort()) {
    const filePath = path.join(workspace.wikiDir, name);
    pages.push(parsePage(filePath, await readText(filePath)));
  }
  return pages;
}

export async function findPage(workspace: WikiWorkspace, id: string): Promise<WikiPage> {
  const pages = await loadPages(workspace);
  const page = pages.find((candidate) => candidate.frontmatter.id === id);
  if (!page) {
    throw new Error(`Wiki page not found: ${id}`);
  }
  return page;
}

export function rankParentCandidates(source: ExtractedSource, pages: WikiPage[], attention?: AttentionIndex): CandidateScore[] {
  const sourceTerms = new Set([...source.keywords, ...source.pathHints, ...tokenize(source.summary)]);
  return pages
    .map((node) => {
      const reasons: string[] = [];
      let score = 0;
      for (const keyword of node.frontmatter.keywords) {
        if (sourceTerms.has(keyword)) {
          score += 3;
          reasons.push(`keyword:${keyword}`);
        }
      }
      for (const term of tokenize(`${node.frontmatter.title} ${node.body}`)) {
        if (sourceTerms.has(term)) {
          score += 1;
        }
      }
      if (source.pathHints.some((hint) => node.frontmatter.id.includes(hint))) {
        score += 4;
        reasons.push("path-hint");
      }
      if (node.frontmatter.kind === "root") {
        score += 0.5;
        reasons.push("root-fallback");
      }
      if (node.frontmatter.kind === "pattern") {
        score += 1;
        reasons.push("pattern-page");
      }
      const boost = attention ? attentionBoost(attention, node.frontmatter.id) : 0;
      if (boost > 0) {
        score += boost;
        reasons.push(`attention:${boost.toFixed(2)}`);
      }
      return { node, score, reasons: uniqueValues(reasons) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export function createChildPage(workspace: WikiWorkspace, source: ExtractedSource, parentId: string, confidence: number): WikiPage {
  const createdAt = nowIso();
  const id = wikiIdFromTitle(`${source.title} ${source.checksum.slice(0, 6)}`);
  return {
    path: path.join(workspace.wikiDir, pageFileName(id)),
    frontmatter: {
      id,
      title: source.title,
      kind: "source",
      parent: parentId,
      children: [],
      keywords: source.keywords,
      references: [source.sourcePath],
      sourcePath: source.sourcePath,
      checksum: source.checksum,
      confidence,
      createdAt,
      updatedAt: createdAt
    },
    body: [
      `# ${source.title}`,
      "",
      "## Summary",
      "",
      source.summary,
      "",
      "## Source",
      "",
      `[1] ${source.sourcePath}`,
      "",
      "## Extracted Signals",
      "",
      `Keywords: ${source.keywords.join(", ") || "none"}`,
      "",
      `Entities: ${source.entities.join(", ") || "none"}`,
      "",
      "## Preview",
      "",
      source.contentPreview
    ].join("\n")
  };
}

export async function writePage(page: WikiPage): Promise<void> {
  await writeText(page.path, formatPage(page));
}

export async function updateParentWithChild(parent: WikiPage, child: WikiPage): Promise<WikiPage> {
  const now = nowIso();
  const children = uniqueValues([...parent.frontmatter.children, child.frontmatter.id]);
  const references = uniqueValues([...parent.frontmatter.references, child.frontmatter.id]);
  const updated: WikiPage = {
    ...parent,
    frontmatter: {
      ...parent.frontmatter,
      children,
      references,
      updatedAt: now
    },
    body: renderParentBody(parent, children, child)
  };
  await writePage(updated);
  return updated;
}

export function buildReferences(page: WikiPage, pages: WikiPage[]): TraversalReference[] {
  const byId = new Map(pages.map((candidate) => [candidate.frontmatter.id, candidate]));
  const refs: TraversalReference[] = [];
  if (page.frontmatter.parent) {
    const parent = byId.get(page.frontmatter.parent);
    refs.push({
      label: "[0]",
      targetId: page.frontmatter.parent,
      targetTitle: parent?.frontmatter.title ?? page.frontmatter.parent,
      kind: "parent"
    });
  }
  page.frontmatter.children.forEach((childId, index) => {
    const child = byId.get(childId);
    refs.push({
      label: `[${index + 1}]`,
      targetId: childId,
      targetTitle: child?.frontmatter.title ?? childId,
      kind: "child"
    });
  });
  return refs;
}

export function searchPages(query: string, pages: WikiPage[]) {
  const queryTerms = new Set(tokenize(query));
  return pages
    .map((page) => {
      let score = 0;
      for (const keyword of page.frontmatter.keywords) {
        if (queryTerms.has(keyword)) {
          score += 4;
        }
      }
      for (const token of tokenize(`${page.frontmatter.title} ${page.body}`)) {
        if (queryTerms.has(token)) {
          score += 1;
        }
      }
      return { page, score, references: buildReferences(page, pages) };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
}

function renderParentBody(parent: WikiPage, children: string[], latestChild: WikiPage): string {
  const existingIntro = parent.body.split("\n## Children")[0].trim();
  const childLines = children.map((childId, index) => {
    const title = childId === latestChild.frontmatter.id ? latestChild.frontmatter.title : childId.replace(/^wiki:\/\//, "");
    return `[${index + 1}] ${title} -> ${childId}`;
  });
  return [
    existingIntro || `# ${parent.frontmatter.title}`,
    "",
    "## Children",
    "",
    childLines.join("\n") || "_No children yet._",
    "",
    "## Notes",
    "",
    `Last linked child: ${latestChild.frontmatter.title}`
  ].join("\n");
}
