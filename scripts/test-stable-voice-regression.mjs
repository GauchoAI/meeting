#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stablePath = resolve(root, "apps/web/public/stable.html");
const source = readFileSync(stablePath, "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL stable voice regression: ${message}`);
    process.exitCode = 1;
  }
}

function section(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert(start >= 0, `missing function ${name}`);
  if (start < 0) return "";
  const next = source.indexOf("\n    function ", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
}

const playPeerAssistantAudioBlob = section("playPeerAssistantAudioBlob");
const localAcousticBargeInEnabled = section("localAcousticBargeInEnabled");
const interruptLocalSpeechForBargeIn = section("interruptLocalSpeechForBargeIn");
const runLocalVadTick = section("runLocalVadTick");

// Guest playback must remain the stable relay path. Past guest barge-in attempts broke this.
assert(!source.includes("peerAssistantAudios"), "guest assistant audio registry must not be enabled by default");
assert(!source.includes("startGuestBargeInGuard"), "guest barge-in guard must not be enabled by default");
assert(!source.includes("assistant.audio.stop"), "host-driven guest audio stop signal must not be enabled by default");
assert(playPeerAssistantAudioBlob.includes("await audio.play();"), "guest assistant relay must directly play received audio");
assert(playPeerAssistantAudioBlob.includes("audio.onended = () => URL.revokeObjectURL(url);"), "guest relay cleanup should preserve stable playback shape");

// Local host barge-in should be available independent of push-to-talk/auto-vad mode.
assert(localAcousticBargeInEnabled.includes('if (configured === "false") return false;'), "local acoustic barge-in should keep opt-out");
assert(localAcousticBargeInEnabled.includes("return true;"), "local acoustic barge-in should default on");
assert(source.includes("function localBargeInGraceMs() {\n      return 0;\n    }"), "local barge-in should have no startup grace delay");
assert(source.includes("const defaultMs = localCaptureMode() === \"auto-vad\" ? 120 : 120;"), "local barge-in hold should be short");

// When host speaks over assistant TTS, capture immediately instead of discarding the turn.
assert(runLocalVadTick.includes("const bargeInVoice ="), "local VAD should compute explicit barge-in voice state");
assert(runLocalVadTick.includes("localSttSuppressUploadsUntil = 0;"), "barge-in should clear upload suppression");
assert(runLocalVadTick.includes("startLocalSpeechRecorder();"), "barge-in should start recorder immediately");
assert(interruptLocalSpeechForBargeIn.includes("localSttSuppressUploadsUntil = 0;"), "interrupt should not suppress uploads");
assert(interruptLocalSpeechForBargeIn.includes("localSttDiscardCurrentChunk = false;"), "interrupt should not discard the human turn");
assert(interruptLocalSpeechForBargeIn.includes("local voice interrupted; recording"), "interrupt status should say recording");

if (!process.exitCode) console.log("stable voice regression checks passed");
