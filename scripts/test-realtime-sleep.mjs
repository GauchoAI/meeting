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
assert.match(stable, /function enqueueLocalVoiceSegments/, "stable shell chunks full local voice messages instead of clipping them");
assert.match(stable, /enqueueLocalVoiceSegments\(message, \{ clearExisting: direct \}\)/, "direct Pi voice messages use segmented local TTS");
assert.doesNotMatch(stable, /clipText\(envelope\.message[^)]*,\s*360\)/, "direct Pi voice messages are not capped at 360 chars");
assert.match(stable, /\(\?=\[A-Z0-9_\]\*\(\?:\[_0-9\]\|=\)\)/, "spoken acronym sanitizer requires env-like uppercase identifiers");
assert.match(stable, /id="captureMode"/, "stable shell exposes the local capture mode selector");
assert.match(stable, /value="auto-vad">Hands-free/, "stable shell exposes hands-free local VAD capture");
assert.match(stable, /setLocalCaptureMode/, "stable shell persists capture-mode changes");
assert.match(stable, /if \(configured === "false"\) return false;\s*return true;/, "local acoustic barge-in defaults on with opt-out");
assert.match(stable, /localCaptureMode\(\) === "auto-vad" \? 1600 : 900/, "hands-free capture waits longer before closing a spoken turn");
assert.match(stable, /waitForLocalSpeechPlaybackTurn/, "local TTS waits for the host turn before playback");
assert.match(stable, /cancelLocalSpeechForHostContinuation/, "pending local TTS is cancelled when the host continues speaking");
assert.match(stable, /handleLocalHostUtteranceForPendingSpeech/, "confirmed host utterances cancel pending local TTS");
assert.match(stable, /event\.type !== "utterance\.final"/, "pending local TTS cancellation is tied to finalized host speech");
assert.doesNotMatch(stable, /if \(localSpeechCurrentItem \|\| localSpeechQueue\.length\) \{\s*cancelLocalSpeechForHostContinuation/s, "raw VAD mic level only defers local TTS; it does not cancel it");
assert.match(stable, /localUnconfirmedMicDeferMs/, "unconfirmed mic activity has a bounded playback defer window");
assert.match(stable, /Continuing local voice after unconfirmed mic activity/, "local TTS resumes when mic activity never becomes a transcript");
assert.match(stable, /preparing local voice; listening/, "local TTS preparation keeps listening instead of immediately guarding the mic");
assert.match(stable, /_meetingStoppedAt = Date\.now\(\)/, "stable shell captures the browser speech-stop timestamp");
assert.match(stable, /params\.set\("clientStoppedAt"/, "local STT upload sends the browser speech-stop timestamp");
assert.match(stable, /local\.tts\.playback\.start/, "stable shell traces the first audible local TTS playback point");

console.log("Realtime sleep state tests passed.");
