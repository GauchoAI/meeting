#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stablePath = resolve(root, "apps/web/public/stable.html");
const apiPath = resolve(root, "apps/api/src/server.ts");
const latencyScriptPath = resolve(root, "scripts/measure-meeting-latency.mjs");
const packagePath = resolve(root, "package.json");
const pagesWorkflowPath = resolve(root, ".github/workflows/pages.yml");
const source = readFileSync(stablePath, "utf8");
const apiSource = readFileSync(apiPath, "utf8");
const latencyScript = readFileSync(latencyScriptPath, "utf8");
const packageSource = readFileSync(packagePath, "utf8");
const pagesWorkflow = readFileSync(pagesWorkflowPath, "utf8");

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL stable voice regression: ${message}`);
    process.exitCode = 1;
  }
}

function assertNear(actual, expected, epsilon, message) {
  assert(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
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
const sendMeetingAudioChunk = section("sendMeetingAudioChunk");
const sendPeerAudioChunk = section("sendPeerAudioChunk");
const sendAudioChunk = section("sendAudioChunk");

// Guest playback must remain the stable relay path. Past guest barge-in attempts broke this.
assert(!source.includes("peerAssistantAudios"), "guest assistant audio registry must not be enabled by default");
assert(!source.includes("startGuestBargeInGuard"), "guest barge-in guard must not be enabled by default");
assert(!source.includes("assistant.audio.stop"), "host-driven guest audio stop signal must not be enabled by default");
assert(playPeerAssistantAudioBlob.includes("await audio.play();"), "guest assistant relay must directly play received audio");
assert(playPeerAssistantAudioBlob.includes("audio.onended = () => URL.revokeObjectURL(url);"), "guest relay cleanup should preserve stable playback shape");
assert(sendPeerAudioChunk.includes("sendMeetingAudioChunk({"), "guest STT upload should use the shared audio chunk sender");
assert(sendPeerAudioChunk.includes('client: "stable-webrtc-peer-v1"'), "guest STT upload should keep the stable WebRTC client id");

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
assert(sendAudioChunk.includes("sendMeetingAudioChunk({"), "host STT upload should use the shared audio chunk sender");
assert(sendAudioChunk.includes('client: "stable-vad-v1"'), "host STT upload should keep the stable local VAD client id");

// Perceived latency depends on browser speech-stop timestamps and first playback traces.
assert(source.includes("_meetingStoppedAt = Date.now();"), "host recorder should capture the speech-stop timestamp");
assert(source.includes("sendAudioChunk(blob, startedAt, stoppedAt);"), "host upload should include speech-start and speech-stop timestamps");
assert(source.includes('sendPeerAudioChunk(blob, peer.name || "Guest", startedAt, stoppedAt);'), "guest upload should include speech-start and speech-stop timestamps");
assert(sendMeetingAudioChunk.includes('params.set("clientStoppedAt"'), "shared audio chunk sender should forward clientStoppedAt");
assert(apiSource.includes("clientStopToApiMs"), "API should trace speech-stop to upload latency");
assert(apiSource.includes("clientStopToUtteranceMs"), "API should trace speech-stop to final transcript latency");
assert(source.includes('"local.tts.playback.start"'), "stable shell should trace first audible local TTS playback");
assert(latencyScript.includes("speechEndToPlaybackStart"), "latency report should include speech-stop to playback metric");
assert(latencyScript.includes("speechEnd→play"), "latency report should print the perceived playback metric");

// Deploy must run the same repeatable checks before publishing the stable client.
assert(packageSource.includes('"test:stable-voice"'), "root package should expose the stable voice regression command");
assert(pagesWorkflow.includes("Stable voice regression checks"), "Pages workflow should name the stable voice gate");
assert(pagesWorkflow.includes("pnpm -s test:stable-voice"), "Pages workflow should run stable voice regression checks before build/deploy");
assert(pagesWorkflow.includes("node-version: 24"), "Pages workflow should run on the current Node major");

// The latency report should compute human-perceived latency from speech stop to first playback.
const tempDir = mkdtempSync(resolve(tmpdir(), "meeting-latency-"));
try {
  const base = Date.parse("2026-05-17T08:00:00.000Z");
  const clientStoppedAt = base + 1000;
  const latencyFixture = [
    {
      id: "trace_audio",
      type: "agent.trace",
      createdAt: new Date(base + 1010).toISOString(),
      agentId: "meeting-api",
      channel: "latency",
      text: "audio.upload.received",
      details: {
        clientStartedAt: base - 2000,
        clientStoppedAt
      }
    },
    {
      id: "utt_host",
      type: "utterance.final",
      createdAt: new Date(base + 1200).toISOString(),
      speakerLabel: "Host",
      text: "Hello"
    },
    {
      id: "trace_playback",
      type: "agent.trace",
      createdAt: new Date(base + 1650).toISOString(),
      agentId: "realtime-codex",
      channel: "latency",
      text: "local.tts.playback.start",
      details: {}
    }
  ];
  const fixturePath = resolve(tempDir, "events.jsonl");
  writeFileSync(fixturePath, `${latencyFixture.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const report = JSON.parse(execFileSync(process.execPath, [latencyScriptPath, "--file", fixturePath, "--since", "2026-05-17T07:59:00.000Z", "--json"], { encoding: "utf8" }));
  assert(report.rows.length === 1, "latency report should parse the synthetic host utterance");
  assertNear(report.rows[0]?.speechEndToPlaybackStart, 0.65, 0.001, "latency report should compute speech-stop to playback seconds");
  assert(report.summary.speechEndToPlaybackStart.n === 1, "latency report should summarize speech-stop to playback");
  assert(report.summary.speechEndToPlaybackStart.max < 1, "synthetic perceived latency budget should stay under one second");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (!process.exitCode) console.log("stable voice regression checks passed");
