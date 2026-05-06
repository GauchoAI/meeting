import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { consumeNextMeetingRoute, isMeetingTaskClass, peekNextMeetingRoute, setNextMeetingRoute, type MeetingTaskClass } from "../lib/meeting-route-state";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface RouteTarget {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}

interface RouteConfig {
  primary: RouteTarget;
  fallback?: RouteTarget;
}

const DEFAULT_TASK_CLASS: MeetingTaskClass = "conversation";

const defaultRoutes: Record<MeetingTaskClass, RouteConfig> = {
  "artifact.render": {
    primary: { provider: "openai-codex", model: "gpt-5.3-codex-spark", thinking: "low" },
    fallback: { provider: "openai-codex", model: "gpt-5.5", thinking: "medium" }
  },
  "artifact.edit": {
    primary: { provider: "openai-codex", model: "gpt-5.3-codex-spark", thinking: "low" },
    fallback: { provider: "openai-codex", model: "gpt-5.5", thinking: "medium" }
  },
  "code.change": {
    primary: { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
    fallback: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "high" }
  },
  "research.explore": {
    primary: { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
    fallback: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "high" }
  },
  "critique.review": {
    primary: { provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
    fallback: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "high" }
  },
  conversation: {
    primary: { provider: "openai-codex", model: "gpt-5.5", thinking: "medium" },
    fallback: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "medium" }
  }
};

export default function meetingRouter(pi: ExtensionAPI) {
  pi.registerFlag("meeting-router", {
    description: "Route each meeting turn by explicit task class",
    type: "boolean",
    default: true
  });

  pi.registerFlag("meeting-router-default", {
    description: "Default meeting task class",
    type: "string",
    default: DEFAULT_TASK_CLASS
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("meeting-router") === false) return;
    const taskClass = defaultTaskClass(pi);
    await applyRoute(pi, ctx, taskClass, "session_start");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (pi.getFlag("meeting-router") === false) return;
    const request = consumeNextMeetingRoute();
    const taskClass = request?.taskClass ?? defaultTaskClass(pi);
    await applyRoute(pi, ctx, taskClass, request?.source ?? "before_agent_start");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("meeting-router", undefined);
  });

  pi.registerCommand("meeting-route", {
    description: "Set or inspect the next meeting route. Usage: /meeting-route [taskClass]",
    handler: async (args, ctx) => {
      const raw = args.trim();
      if (!raw) {
        const next = peekNextMeetingRoute();
        const taskClass = next?.taskClass ?? defaultTaskClass(pi);
        const target = loadRoutes(ctx.cwd)[taskClass].primary;
        ctx.ui.notify(`meeting-route next=${taskClass} -> ${target.provider}/${target.model}:${target.thinking}`, "info");
        return;
      }
      if (!isMeetingTaskClass(raw)) {
        ctx.ui.notify(`Unknown task class: ${raw}`, "error");
        return;
      }
      setNextMeetingRoute({ taskClass: raw, source: "command" });
      const target = loadRoutes(ctx.cwd)[raw].primary;
      ctx.ui.notify(`meeting-route next=${raw} -> ${target.provider}/${target.model}:${target.thinking}`, "success");
    }
  });

  pi.registerCommand("meeting-routes", {
    description: "List meeting task-class routes",
    handler: async (_args, ctx) => {
      const lines = Object.entries(loadRoutes(ctx.cwd)).map(([taskClass, route]) => {
        const fallback = route.fallback ? ` fallback ${formatTarget(route.fallback)}` : "";
        return `${taskClass} -> ${formatTarget(route.primary)}${fallback}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });
}

async function applyRoute(pi: ExtensionAPI, ctx: ExtensionContext, taskClass: MeetingTaskClass, source: string): Promise<void> {
  const route = loadRoutes(ctx.cwd)[taskClass];
  const applied = await tryApplyTarget(pi, ctx, route.primary) || (route.fallback ? await tryApplyTarget(pi, ctx, route.fallback) : undefined);
  if (!applied) {
    ctx.ui.notify(`meeting-router: no authenticated route for ${taskClass}`, "warning");
    return;
  }
  ctx.ui.setStatus("meeting-router", `${taskClass} -> ${formatTarget(applied)} (${source})`);
}

function loadRoutes(cwd: string): Record<MeetingTaskClass, RouteConfig> {
  const configPath = resolve(cwd, ".pi", "meeting-routes.json");
  if (!existsSync(configPath)) return defaultRoutes;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Record<MeetingTaskClass, Partial<RouteConfig>>>;
    return mergeRoutes(defaultRoutes, parsed);
  } catch {
    return defaultRoutes;
  }
}

function mergeRoutes(base: Record<MeetingTaskClass, RouteConfig>, override: Partial<Record<MeetingTaskClass, Partial<RouteConfig>>>): Record<MeetingTaskClass, RouteConfig> {
  const next = { ...base };
  for (const [rawTaskClass, rawRoute] of Object.entries(override)) {
    if (!isMeetingTaskClass(rawTaskClass) || !rawRoute?.primary) continue;
    const primary = normalizeTarget(rawRoute.primary);
    if (!primary) continue;
    const fallback = rawRoute.fallback ? normalizeTarget(rawRoute.fallback) : undefined;
    next[rawTaskClass] = { primary, fallback };
  }
  return next;
}

function normalizeTarget(value: Partial<RouteTarget>): RouteTarget | undefined {
  if (!value.provider || !value.model) return undefined;
  return {
    provider: value.provider,
    model: value.model,
    thinking: normalizeThinking(value.thinking)
  };
}

function normalizeThinking(value: unknown): ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "medium";
}

async function tryApplyTarget(pi: ExtensionAPI, ctx: ExtensionContext, target: RouteTarget): Promise<RouteTarget | undefined> {
  const model = ctx.modelRegistry.find(target.provider, target.model);
  if (!model) return undefined;
  const switched = await pi.setModel(model);
  if (!switched) return undefined;
  pi.setThinkingLevel(target.thinking);
  return target;
}

function defaultTaskClass(pi: ExtensionAPI): MeetingTaskClass {
  const value = String(pi.getFlag("meeting-router-default") ?? DEFAULT_TASK_CLASS);
  return isMeetingTaskClass(value) ? value : DEFAULT_TASK_CLASS;
}

function formatTarget(target: RouteTarget): string {
  return `${target.provider}/${target.model}:${target.thinking}`;
}
