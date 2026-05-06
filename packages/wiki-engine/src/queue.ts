import { access, rename } from "node:fs/promises";
import path from "node:path";
import type { QueueItem, WikiWorkspace } from "./types.js";
import { checksum, nowIso, readText, writeText } from "./utils.js";

export async function enqueueFile(workspace: WikiWorkspace, filePath: string): Promise<QueueItem> {
  const content = await readText(filePath);
  const digest = checksum(content);
  const queue = await readQueue(workspace);
  const existing = queue.find((item) => item.path === filePath && item.checksum === digest);
  if (existing) {
    return existing;
  }
  const now = nowIso();
  const item: QueueItem = {
    id: `queue-${digest.slice(0, 12)}`,
    path: filePath,
    checksum: digest,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now
  };
  queue.push(item);
  await writeQueue(workspace, queue);
  return item;
}

export async function nextQueued(workspace: WikiWorkspace): Promise<QueueItem | undefined> {
  return (await readQueue(workspace)).find((item) => item.status === "queued" || item.status === "failed");
}

export async function updateQueueItem(workspace: WikiWorkspace, item: QueueItem): Promise<void> {
  const queue = await readQueue(workspace);
  const index = queue.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) {
    queue.push(item);
  } else {
    queue[index] = item;
  }
  await writeQueue(workspace, queue);
}

export async function readQueue(workspace: WikiWorkspace): Promise<QueueItem[]> {
  try {
    await access(workspace.queuePath);
  } catch {
    return [];
  }
  return JSON.parse(await readText(workspace.queuePath)) as QueueItem[];
}

async function writeQueue(workspace: WikiWorkspace, queue: QueueItem[]): Promise<void> {
  const tmp = path.join(path.dirname(workspace.queuePath), `queue.${process.pid}.tmp`);
  await writeText(tmp, JSON.stringify(queue, null, 2));
  await rename(tmp, workspace.queuePath);
}
