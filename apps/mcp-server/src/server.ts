#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { newEventId, nowIso, type MeetingEvent } from "@meeting/protocol";

const api = process.env.MEETING_API_URL || "http://localhost:4317";
const meetingId = process.env.MEETING_ID || "local-demo";
const agentId = process.env.MEETING_AGENT_ID || "local-agent";

const server = new McpServer({
  name: "meeting",
  version: "0.1.0"
});

server.tool(
  "meeting_raise_hand",
  "Ask the host for permission to speak, show a UI artifact, review, or work.",
  {
    reason: z.string(),
    requestedMode: z.enum(["speak", "show", "work", "review"]).default("show"),
    confidence: z.number().min(0).max(1).default(0.75)
  },
  async ({ reason, requestedMode, confidence }) => {
    await postEvent({
      id: newEventId("hand"),
      type: "agent.hand_raise",
      meetingId,
      createdAt: nowIso(),
      agentId,
      reason,
      requestedMode,
      confidence
    });
    return text(`Raised hand as ${agentId}.`);
  }
);

server.tool(
  "meeting_post_markdown",
  "Render Markdown in the meeting UI. Mermaid code blocks are supported.",
  {
    markdown: z.string(),
    title: z.string().optional()
  },
  async ({ markdown, title }) => {
    await postEvent({
      id: newEventId("msg"),
      type: "agent.message",
      meetingId,
      createdAt: nowIso(),
      agentId,
      format: "markdown",
      text: title ? `# ${title}\n\n${markdown}` : markdown
    });
    return text("Posted Markdown to the meeting UI.");
  }
);

server.tool(
  "meeting_set_repository",
  "Tell the meeting which repository an agent can discuss or work on.",
  {
    owner: z.string(),
    name: z.string(),
    baseBranch: z.string().default("main"),
    localPath: z.string().optional(),
    cloneUrl: z.string().optional()
  },
  async (repository) => {
    await postEvent({
      id: newEventId("repo"),
      type: "repository.context",
      meetingId,
      createdAt: nowIso(),
      repository
    });
    return text(`Repository context set to ${repository.owner}/${repository.name}.`);
  }
);

server.tool(
  "meeting_create_task",
  "Create or update a visible agent work card in the meeting UI.",
  {
    title: z.string(),
    status: z.enum(["queued", "working", "blocked", "done", "failed"]).default("queued"),
    branch: z.string().optional(),
    previewUrl: z.string().optional(),
    details: z.string().optional()
  },
  async ({ title, status, branch, previewUrl, details }) => {
    await postEvent({
      id: newEventId("task"),
      type: "agent.task",
      meetingId,
      createdAt: nowIso(),
      agentId,
      title,
      status,
      branch,
      previewUrl,
      details
    });
    return text(`Task ${status}: ${title}`);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function postEvent(event: MeetingEvent): Promise<void> {
  const res = await fetch(`${api}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event)
  });
  if (!res.ok) {
    throw new Error(`meeting API returned ${res.status}`);
  }
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

