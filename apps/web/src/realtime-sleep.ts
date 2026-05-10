export type RealtimeActivationMode = "active" | "sleeping";

export interface WakeDecisionInput {
  mode: RealtimeActivationMode;
  muted: boolean;
  transcript?: string;
  nowMs: number;
  lastWakeAtMs: number;
  debounceMs?: number;
}

export interface WakeDecision {
  mode: RealtimeActivationMode;
  shouldWake: boolean;
  shouldSpeak: boolean;
  reason: "active" | "muted" | "debounced" | "not_prompt" | "prompt_detected";
}

const defaultDebounceMs = 2500;
const promptPattern = /(?:\?|\b(?:agent|assistant|codex|pi-agent|hey|please|can you|could you|would you|show|open|create|update|fix|look|help)\b)/i;

export function decideRealtimeWake(input: WakeDecisionInput): WakeDecision {
  if (input.mode === "active") {
    return { mode: "active", shouldWake: false, shouldSpeak: !input.muted, reason: input.muted ? "muted" : "active" };
  }
  const elapsed = input.nowMs - input.lastWakeAtMs;
  const debounceMs = input.debounceMs ?? defaultDebounceMs;
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < debounceMs) {
    return { mode: "sleeping", shouldWake: false, shouldSpeak: false, reason: "debounced" };
  }
  if (!isLikelyPrompt(input.transcript || "")) {
    return { mode: "sleeping", shouldWake: false, shouldSpeak: false, reason: "not_prompt" };
  }
  return { mode: "active", shouldWake: true, shouldSpeak: false, reason: "prompt_detected" };
}

export function isLikelyPrompt(text: string): boolean {
  return promptPattern.test(text.trim());
}

export function shouldCreateRealtimeResponse(input: { mode: RealtimeActivationMode; muted: boolean }): boolean {
  return input.mode === "active" && !input.muted;
}

export function realtimeActivationLabel(mode: RealtimeActivationMode): string {
  return mode === "sleeping" ? "sleeping until prompted" : "active";
}
