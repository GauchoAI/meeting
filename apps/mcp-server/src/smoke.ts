import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "pnpm",
  args: ["--filter", "@meeting/mcp-server", "dev"],
  env: {
    ...process.env,
    MEETING_API_URL: process.env.MEETING_API_URL || "http://localhost:4317",
    MEETING_ID: process.env.MEETING_ID || "local-demo",
    MEETING_AGENT_ID: process.env.MEETING_AGENT_ID || "codex-mcp-smoke"
  }
});

const client = new Client({ name: "meeting-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

try {
  const tools = await client.listTools();
  console.log(JSON.stringify({ tools: tools.tools.map((tool) => tool.name) }, null, 2));

  const message = await client.callTool({
    name: "meeting_post_markdown",
    arguments: {
      title: "MCP Smoke Test",
      markdown: [
        "This message was posted through the **meeting MCP server**.",
        "",
        "```mermaid",
        "flowchart LR",
        "  Agent[Codex or Claude] --> MCP",
        "  MCP --> API[Meeting API]",
        "  API --> UI[Meeting UI]",
        "```"
      ].join("\n")
    }
  });
  console.log(JSON.stringify(message, null, 2));

  const hand = await client.callTool({
    name: "meeting_raise_hand",
    arguments: {
      reason: "MCP server is reachable and can update the meeting UI.",
      requestedMode: "show",
      confidence: 0.95
    }
  });
  console.log(JSON.stringify(hand, null, 2));
} finally {
  await client.close();
}
