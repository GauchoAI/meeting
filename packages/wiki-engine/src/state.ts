import { rename } from "node:fs/promises";
import path from "node:path";
import type { AttentionEntry, AttentionIndex, WikiWorkspace } from "./types.js";
import { nowIso, readText, writeText } from "./utils.js";

export function attentionPath(workspace: WikiWorkspace): string {
  return path.join(workspace.stateDir, "attention.json");
}

export async function readAttention(workspace: WikiWorkspace): Promise<AttentionIndex> {
  try {
    return JSON.parse(await readText(attentionPath(workspace))) as AttentionIndex;
  } catch {
    return { entries: {} };
  }
}

export async function recordAttention(
  workspace: WikiWorkspace,
  pageId: string,
  event: "visit" | "search" | "insertion",
  note?: string
): Promise<AttentionEntry> {
  const index = await readAttention(workspace);
  const now = nowIso();
  const current = index.entries[pageId] ?? {
    pageId,
    visits: 0,
    insertions: 0,
    searches: 0,
    lastVisitedAt: now,
    notes: []
  };
  const next: AttentionEntry = {
    ...current,
    visits: current.visits + 1,
    insertions: current.insertions + (event === "insertion" ? 1 : 0),
    searches: current.searches + (event === "search" ? 1 : 0),
    lastVisitedAt: now,
    notes: note ? [...current.notes.slice(-8), note] : current.notes
  };
  index.entries[pageId] = next;
  await writeAttention(workspace, index);
  return next;
}

export function attentionBoost(index: AttentionIndex, pageId: string): number {
  const entry = index.entries[pageId];
  if (!entry) {
    return 0;
  }
  const recency = Math.max(0, 1 - (Date.now() - Date.parse(entry.lastVisitedAt)) / 86_400_000);
  return Math.min(8, Math.log1p(entry.visits) + entry.insertions * 1.2 + entry.searches * 0.6 + recency);
}

async function writeAttention(workspace: WikiWorkspace, index: AttentionIndex): Promise<void> {
  const tmp = path.join(workspace.stateDir, `attention.${process.pid}.tmp`);
  await writeText(tmp, JSON.stringify(index, null, 2));
  await rename(tmp, attentionPath(workspace));
}
