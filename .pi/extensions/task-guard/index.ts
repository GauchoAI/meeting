import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CONTINUATION_PROMPT = `Continue the current implementation now. Do not stop, summarize, ask for confirmation, or hand control back until the objective is complete. Execute the next concrete coding step immediately, validate it, then continue with the next step.`;

const TASK_GUARD_INSTRUCTIONS = `
Task completion guard:
- Treat implementation requests as objective-driven, not turn-driven.
- Continue autonomously until the user's objective is complete.
- Do not stop after a plan, checkpoint, partial pass, commit, validation pass, or status update.
- Do not ask whether to continue. Continue.
- Do not invent ambiguity, blockers, risk, or permission gates as reasons to stop.
- If a tool call succeeds, continue to the next concrete step.
- If a validation command fails, fix the failure and validate again; do not stop merely to report it.
- Only stop when the objective is complete, and state COMPLETED.
`;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: `${event.systemPrompt}\n\n${TASK_GUARD_INSTRUCTIONS}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    const messages = Array.isArray((event as any).messages) ? (event as any).messages : [];
    const assistantText = [...messages]
      .reverse()
      .map((message: any) => message?.content)
      .map(contentToText)
      .find((text: string) => text.trim().length > 0) || "";

    if (!looksLikePrematureCheckpoint(assistantText)) return;

    ctx.ui.notify("Task guard: possible premature checkpoint. Prefilled continuation prompt.", "warning");
    ctx.ui.setEditorText(CONTINUATION_PROMPT);
  });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    return "";
  }).join("\n");
}

function looksLikePrematureCheckpoint(text: string): boolean {
  const lower = text.toLowerCase();
  const saysProceeding = /\b(proceeding|i'll start|i will start|next i'll|next i will)\b/.test(lower);
  const saysPartial = /\b(first pass|phase 1|next step|next improvement|started|partial|initial)\b/.test(lower);
  const noTerminalStatus = !/\b(completed|objective is complete|done)\b/.test(lower);
  return noTerminalStatus && (saysProceeding || saysPartial);
}
