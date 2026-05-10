#!/usr/bin/env node
import { readFileSync } from "node:fs";

const api = readFileSync("apps/api/src/server.ts", "utf8");
const web = readFileSync("apps/web/src/main.tsx", "utf8");
const docs = readFileSync("docs/assistant-output-delivery.md", "utf8");

const checks = [
  [api.includes('name: "deliver_assistant_output"'), "Realtime tool schema exposes deliver_assistant_output"],
  [api.includes('surface: "canvas"') && api.includes('surface: "status"'), "Delivery workflow separates canvas and status surfaces"],
  [api.includes('formatAssistantStatusMarkdown') && api.includes('formatAssistantCanvasMarkdown'), "Delivery workflow uses shared canvas/status formatters"],
  [api.includes('formatPiHandoffForHumans') && api.includes('Task: ${input.title}') && api.includes('Output: ${inferHumanOutputTarget'), "Pi handoff utterances use Task/Context/Constraints/Output format"],
  [api.includes('Send a concise structured implementation handoff') && web.includes('run_codex_task sends a concise structured handoff'), "Realtime handoff instructions avoid user-facing JSONL wording"],
  [!api.includes('Treat the JSONL below as the task handoff') && !api.includes('Use the Meeting artifact tools to answer in the Meeting UI'), "Human-facing handoffs do not expose raw JSONL boilerplate"],
  [web.includes('const autoCanvasMessages = selectableCanvasMessages.filter((event) => !isTaskResultWrapperMessage(event))') && web.includes('const focusedCanvasMessage') && !web.includes('setSelectedCanvasDocumentId(latestCanvas.documentId)'), "Web UI keeps manual canvas focus while Auto follows real canvas documents"],
  [api.includes('!isTaskResultWrapperMessage(event)') && web.includes('documentId.startsWith("task-result:")'), "Task-result wrappers do not override artifact canvas selection"],
  [web.includes('event.surface === "status" && !event.documentId && event.stream !== "implementation"') && !web.includes('text.length >= 40'), "Realtime notification ignores status-only pi-agent wrappers"],
  [web.includes('Task: Review latest Pi/Codex output.') && web.includes('status-only updates should not replace it') && !web.includes('Context: surface='), "Realtime Pi updates use preferred message format without routing metadata"],
  [docs.includes('deliver_assistant_output') && docs.includes('Status: <one-line current state>') && docs.includes('status-only delivery replace'), "Delivery workflow docs describe command and template"]
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  console.error("Assistant delivery guardrails failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Assistant delivery guardrails passed.");
