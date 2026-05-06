import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

}
