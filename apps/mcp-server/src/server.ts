#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMeetingMcpServer } from "./create-server.js";

const transport = new StdioServerTransport();
const server = createMeetingMcpServer();
await server.connect(transport);
