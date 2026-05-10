#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decideRealtimeWake,
  isLikelyPrompt,
  shouldCreateRealtimeResponse
} from "../apps/web/src/realtime-sleep.ts";

assert.equal(shouldCreateRealtimeResponse({ mode: "active", muted: false }), true, "active + unmuted may create audio responses");
assert.equal(shouldCreateRealtimeResponse({ mode: "active", muted: true }), false, "muted active mode stays silent");
assert.equal(shouldCreateRealtimeResponse({ mode: "sleeping", muted: false }), false, "sleeping mode never auto-creates responses");
assert.equal(shouldCreateRealtimeResponse({ mode: "sleeping", muted: true }), false, "sleeping + muted stays silent");

assert.equal(isLikelyPrompt("can you inspect this?"), true, "prompt-like speech wakes");
assert.equal(isLikelyPrompt("background chatter in the room"), false, "non-prompt speech does not wake");

assert.deepEqual(
  decideRealtimeWake({ mode: "active", muted: false, nowMs: 10_000, lastWakeAtMs: 0 }),
  { mode: "active", shouldWake: false, shouldSpeak: true, reason: "active" },
  "active unmuted state speaks normally"
);

assert.deepEqual(
  decideRealtimeWake({ mode: "active", muted: true, nowMs: 10_000, lastWakeAtMs: 0 }),
  { mode: "active", shouldWake: false, shouldSpeak: false, reason: "muted" },
  "muted state preserves background semantics"
);

assert.deepEqual(
  decideRealtimeWake({ mode: "sleeping", muted: false, transcript: "ambient discussion", nowMs: 10_000, lastWakeAtMs: 0 }),
  { mode: "sleeping", shouldWake: false, shouldSpeak: false, reason: "not_prompt" },
  "sleeping mode ignores VAD without a prompt"
);

assert.deepEqual(
  decideRealtimeWake({ mode: "sleeping", muted: false, transcript: "hey agent can you help", nowMs: 10_000, lastWakeAtMs: 0 }),
  { mode: "active", shouldWake: true, shouldSpeak: false, reason: "prompt_detected" },
  "prompt-like VAD wakes but does not immediately speak"
);

assert.deepEqual(
  decideRealtimeWake({ mode: "sleeping", muted: false, transcript: "can you help", nowMs: 11_000, lastWakeAtMs: 10_000 }),
  { mode: "sleeping", shouldWake: false, shouldSpeak: false, reason: "debounced" },
  "wake behavior is debounced to avoid flapping"
);

const main = readFileSync("apps/web/src/main.tsx", "utf8");
const stable = readFileSync("apps/web/public/stable.html", "utf8");
assert.match(main, /setRealtimeAgentSleepMode/, "main UI exposes sleep transition");
assert.match(main, /handleSleepingRealtimeTurn/, "main UI handles VAD wake gate");
assert.match(main, /shouldCreateRealtimeResponse\(\{ mode: activationMode, muted \}\)/, "main Realtime session disables auto responses while sleeping");
assert.match(stable, /meeting:realtime:activation/, "stable shell accepts sleep\/wake command from embedded UI");
assert.match(stable, /create_response: shouldCreateRealtimeResponse\(\)/, "stable shell disables auto responses while sleeping");
assert.match(stable, /handleSleepingRealtimeTurn/, "stable shell handles VAD wake gate");

console.log("Realtime sleep state tests passed.");
