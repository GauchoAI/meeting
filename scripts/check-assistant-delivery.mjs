#!/usr/bin/env node
import { readFileSync } from "node:fs";

const api = readFileSync("apps/api/src/server.ts", "utf8");
const web = readFileSync("apps/web/src/main.tsx", "utf8");
const stable = readFileSync("apps/web/public/stable.html", "utf8");
const docs = readFileSync("docs/assistant-output-delivery.md", "utf8");
const directDocs = readFileSync("docs/agent-direct-messaging.md", "utf8");
const promptDocs = readFileSync("docs/pi-meeting-prompt-wrapping.md", "utf8");
const mcp = readFileSync("apps/mcp-server/src/create-server.ts", "utf8");
const worker = readFileSync("apps/agent-worker/src/worker.ts", "utf8");
const piMeeting = readFileSync(".pi/extensions/meeting/index.ts", "utf8");

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
  [api.includes('name: "message_pi_agent"') && api.includes('pi-direct-messages.jsonl') && api.includes('piDirectMessagesSeenPath'), "Realtime exposes direct voice-agent to pi-agent messaging without canvas output"],
  [api.includes('directMessagePrompt') && api.includes('taskClass: "conversation"') && api.includes('delegatedTo: "pi-agent"'), "Direct voice-agent messages are injected into pi-agent like Codex tasks"],
  [api.includes('speakerId: "realtime-direct-message"') && api.includes('directMessageForTerminal') && api.includes('Voice agent request') && api.includes('Reply now with meeting_message_voice_agent') && !api.includes('Task: Respond to Realtime coordination message'), "Direct voice-agent messages are mirrored as concise reply-oriented pi prompts"],
  [web.includes('isVoiceAgentDirectMessage') && web.includes('call message_pi_agent exactly once') && stable.includes('isVoiceAgentDirectMessage') && stable.includes('call message_pi_agent exactly once'), "Voice-agent direct replies trigger one bounded Realtime-to-Pi continuation turn"],
  [piMeeting.includes('isRealtimeDirectMessage') && piMeeting.includes('passthrough: isRealtimeInjectedMessage') && piMeeting.includes('? text'), "Pi extension passes Realtime direct/handoff messages through without re-wrapping"],
  [piMeeting.includes('name: "meeting_message_voice_agent"') && piMeeting.includes('voice-message:${newEventId("voice")}') && piMeeting.includes('markVoiceToolSatisfied'), "Pi extension exposes direct voice-agent reply tool"],
  [piMeeting.includes('intent.decision === "conversation_only"') && piMeeting.includes('MEETING_VERBOSE_ARTIFACT_CONTEXT') && piMeeting.includes('artifactIndex:'), "Pi extension hides artifact indexes by default and keeps them behind verbose prompt context"],
  [api.includes('type: "agent.task"') && api.includes('status: "queued"') && api.includes('implementationPrompt: prompt.trim()'), "run_codex_task enqueues an implementation task directly"],
  [worker.includes('handlePiDirectMessage') && worker.includes('[pi-agent:direct:') && worker.includes('piDirectMessagesSeenPath'), "Pi-agent worker tails and visibly logs direct messages"],
  [worker.includes('[pi-agent:implementation:working]') && worker.includes('[pi-agent:implementation:${status}]'), "Pi-agent worker visibly logs implementation task lifecycle"],
  [mcp.includes('meeting_message_voice_agent') && mcp.includes('voice-message:'), "Pi-agent can message voice agent without canvas updates"],
  [api.includes('shouldPublishTaskCanvas') && worker.includes('shouldPublishTaskCanvas'), "Code-change implementation results avoid stealing the canvas"],
  [docs.includes('deliver_assistant_output') && docs.includes('Status: <one-line current state>') && docs.includes('status-only delivery replace'), "Delivery workflow docs describe command and template"],
  [directDocs.includes('Task: <actionable request>') && directDocs.includes('message_pi_agent') && directDocs.includes('meeting_message_voice_agent') && directDocs.includes('back-and-forth in the voice-agent channel') && directDocs.includes('NO_ACTION'), "Direct messaging docs describe low-noise handoffs"],
  [promptDocs.includes('Root Cause') && promptDocs.includes('injectMeetingPrompt') && promptDocs.includes('MEETING_VERBOSE_ARTIFACT_CONTEXT') && promptDocs.includes('voice-message:*'), "Prompt wrapper docs capture the coordination metadata regression and fix"]
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  console.error("Assistant delivery guardrails failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Assistant delivery guardrails passed.");
