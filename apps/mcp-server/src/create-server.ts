import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { newEventId, nowIso, type MeetingEvent } from "@meeting/protocol";

export function createMeetingMcpServer() {
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
      await postEvent(api, {
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
    "meeting_message_voice_agent",
    "Send a concise private coordination message to the Realtime voice agent without updating the canvas. Use this to ask it to raise its hand or speak a short summary on your behalf.",
    {
      message: z.string(),
      intent: z.enum(["inform", "raise-hand", "speak", "question"]).default("inform"),
      when: z.string().optional()
    },
    async ({ message, intent, when }) => {
      await postEvent(api, {
        id: newEventId("msg"),
        type: "agent.message",
        stream: "conversation",
        meetingId,
        createdAt: nowIso(),
        agentId,
        format: "plain",
        surface: "status",
        lifecycle: "final",
        documentId: `voice-message:${newEventId("voice")}`,
        text: [
          "For voice agent:",
          `Intent: ${intent}`,
          `Message: ${message}`,
          when ? `When: ${when}` : ""
        ].filter(Boolean).join("\n")
      } as MeetingEvent);
      return text("Sent voice-agent message without updating the canvas.");
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
      await postEvent(api, {
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
      await postEvent(api, {
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
      taskClass: z.enum(["artifact.render", "artifact.edit", "code.change", "research.explore", "critique.review", "conversation"]).optional(),
      branch: z.string().optional(),
      previewUrl: z.string().optional(),
      details: z.string().optional()
    },
    async ({ title, status, taskClass, branch, previewUrl, details }) => {
      await postEvent(api, {
        id: newEventId("task"),
        type: "agent.task",
        meetingId,
        createdAt: nowIso(),
        agentId,
        title,
        status,
        taskClass,
        branch,
        previewUrl,
        details
      });
      return text(`Task ${status}: ${title}`);
    }
  );

  return server;
}

async function postEvent(api: string, event: MeetingEvent): Promise<void> {
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
