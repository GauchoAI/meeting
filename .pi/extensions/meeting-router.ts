import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const ROUTED_PROVIDER = "openai-codex";
const ROUTED_MODEL = "gpt-5.3-codex-spark";
const ROUTED_THINKING = "low";

export default function meetingRouter(pi: ExtensionAPI) {
  pi.registerFlag("meeting-router", {
    description: "Route meeting repo sessions to the fast Codex model",
    type: "boolean",
    default: true
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("meeting-router") === false) return;

    const model = ctx.modelRegistry.find(ROUTED_PROVIDER, ROUTED_MODEL);
    if (!model) {
      ctx.ui.notify(`meeting-router: ${ROUTED_PROVIDER}/${ROUTED_MODEL} not found`, "warning");
      return;
    }

    const switched = await pi.setModel(model);
    if (!switched) {
      ctx.ui.notify(`meeting-router: authentication missing for ${ROUTED_PROVIDER}`, "warning");
      return;
    }

    pi.setThinkingLevel(ROUTED_THINKING);
    ctx.ui.setStatus("meeting-router", `${ROUTED_PROVIDER}/${ROUTED_MODEL}:${ROUTED_THINKING}`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("meeting-router", undefined);
  });

  pi.registerCommand("meeting-router", {
    description: "Show the active meeting router target model",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`meeting-router -> ${ROUTED_PROVIDER}/${ROUTED_MODEL}:${ROUTED_THINKING}`, "info");
    }
  });
}
