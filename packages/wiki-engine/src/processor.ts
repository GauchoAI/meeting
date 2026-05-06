import type { ProcessResult, QueueItem, WikiWorkspace } from "./types.js";
import { extractSource } from "./extractor.js";
import { nextQueued, updateQueueItem } from "./queue.js";
import { decideParent, type RouterOptions } from "./router.js";
import { readAttention, recordAttention } from "./state.js";
import { nowIso, readText } from "./utils.js";
import { createChildPage, findPage, loadPages, rankParentCandidates, updateParentWithChild, writePage } from "./wiki.js";

export async function processNext(workspace: WikiWorkspace, options: RouterOptions = {}): Promise<ProcessResult | undefined> {
  const item = await nextQueued(workspace);
  if (!item) {
    return undefined;
  }
  return processItem(workspace, item, options);
}

export async function processItem(
  workspace: WikiWorkspace,
  item: QueueItem,
  options: RouterOptions = {}
): Promise<ProcessResult> {
  const processing: QueueItem = {
    ...item,
    status: "processing",
    attempts: item.attempts + 1,
    updatedAt: nowIso(),
    error: undefined
  };
  await updateQueueItem(workspace, processing);

  try {
    const content = await readText(item.path);
    const extracted = extractSource(workspace, item.path, content);
    const pages = await loadPages(workspace);
    const attention = await readAttention(workspace);
    const candidates = rankParentCandidates(extracted, pages, attention);
    const decision = await decideParent(extracted, candidates, options);
    const parent = await findPage(workspace, decision.parentId);
    const page = createChildPage(workspace, extracted, parent.frontmatter.id, decision.confidence);
    await writePage(page);
    const updatedParent = await updateParentWithChild(parent, page);
    await recordAttention(workspace, parent.frontmatter.id, "insertion", `accepted child ${page.frontmatter.id}`);
    await recordAttention(workspace, page.frontmatter.id, "visit", `created from ${extracted.sourcePath}`);

    await updateQueueItem(workspace, {
      ...processing,
      status: "done",
      updatedAt: nowIso(),
      resultNodeId: page.frontmatter.id
    });

    return {
      item: {
        ...processing,
        status: "done",
        updatedAt: nowIso(),
        resultNodeId: page.frontmatter.id
      },
      extracted,
      decision,
      page,
      updatedParent
    };
  } catch (error) {
    await updateQueueItem(workspace, {
      ...processing,
      status: "failed",
      updatedAt: nowIso(),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function drainQueue(workspace: WikiWorkspace, options: RouterOptions = {}): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  for (;;) {
    const result = await processNext(workspace, options);
    if (!result) {
      return results;
    }
    results.push(result);
  }
}
