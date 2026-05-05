#!/usr/bin/env node
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMeetingMcpServer } from "./create-server.js";

const port = Number(process.env.MEETING_MCP_PORT || 4318);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name: "meeting-mcp", endpoint: "/mcp" }));
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null
    }));
    return;
  }

  const mcpServer = createMeetingMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
  } catch (error) {
    console.error("[meeting-mcp] request failed", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      }));
    }
  }
});

httpServer.listen(port, () => {
  console.log(`[meeting-mcp] http://localhost:${port}/mcp`);
});
