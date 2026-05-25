#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
function parseNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function parseTime(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`Invalid timestamp: ${value}`);
  return t;
}
function seconds(ms) {
  return ms == null ? null : ms / 1000;
}
function summarize(rows, key) {
  const values = rows
    .map((r) => r[key])
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return { n: 0, min: null, median: null, mean: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  const p = (pVal) => sorted[Math.floor((sorted.length - 1) * pVal)];
  return {
    n: values.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median: p(0.5),
    p90: p(0.9)
  };
}

function readJsonlTail(filePath, mb) {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs);
  const bytes = Math.max(1, Math.floor(mb * 1024 * 1024));
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(abs, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

const file = argValue('--file', '.meeting/events.jsonl');
const tailMb = Number(argValue('--tail-mb', '80'));
const since = argValue('--since', null);
const speaker = argValue('--speaker', 'Host');
const windowSeconds = Number(argValue('--window-s', '60'));
const sttLookbackSeconds = Number(argValue('--stt-lookback-s', '15'));
const baselineMean = parseNum(argValue('--baseline-mean', '11.337'), 11.337);
const baselineP90 = parseNum(argValue('--baseline-p90', '23.164'), 23.164);
const targetPercent = parseNum(argValue('--target-percent', '0'), 0);
const targetAbsolute = parseNum(argValue('--target-absolute', '0'), 0);

const threshold = since ? parseTime(since) : null;
const raw = readJsonlTail(file, tailMb);
const events = [];
let malformed = 0;

for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (!event.createdAt) continue;
    const timeMs = parseTime(event.createdAt);
    if (threshold != null && timeMs < threshold) continue;
    events.push({ ...event, timeMs });
  } catch {
    malformed += 1;
  }
}
events.sort((a, b) => a.timeMs - b.timeMs);

const rows = [];
for (let i = 0; i < events.length; i += 1) {
  const utterance = events[i];
  if (utterance.type !== 'utterance.final' || utterance.speakerLabel !== speaker) continue;
  const t0 = utterance.timeMs;
  const previous = [];
  for (let j = i - 1; j >= 0; j -= 1) {
    if ((t0 - events[j].timeMs) / 1000 > sttLookbackSeconds) break;
    previous.push(events[j]);
  }
  const following = [];
  for (let j = i + 1; j < events.length; j += 1) {
    if ((events[j].timeMs - t0) / 1000 > windowSeconds) break;
    following.push(events[j]);
  }

  const audioUpload = previous.find((e) => e.type === 'agent.trace' && e.agentId === 'meeting-api' && e.text === 'audio.upload.received');
  const sttStart = previous.find((e) => e.type === 'agent.trace' && e.agentId === 'meeting-api' && e.text === 'stt.start');
  const sttEnd = previous.find((e) => e.type === 'agent.trace' && e.agentId === 'meeting-api' && e.text === 'stt.end');
  const agentReceived = following.find((e) => e.type === 'agent.trace' && e.agentId === 'pi-agent' && e.text === 'pi.extension.received_utterance');
  const agentStart = following.find((e) => e.type === 'agent.trace' && e.agentId === 'pi-agent' && e.text === 'agent_start');
  const finalMessage = following.find((e) => e.type === 'agent.message' && e.agentId === 'pi-agent' && e.lifecycle === 'final');
  const ttsStart = following.find((e) => e.type === 'agent.trace' && e.agentId === 'meeting-api' && e.text === 'tts.stream.start');
  const ttsEnd = following.find((e) => e.type === 'agent.trace' && e.agentId === 'meeting-api' && e.text === 'tts.stream.end');
  const playbackStart = following.find((e) => e.type === 'agent.trace' && e.agentId === 'realtime-codex' && e.text === 'local.tts.playback.start');

  const numberValue = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const clientStartedAt = numberValue(audioUpload?.details?.clientStartedAt);
  const clientStoppedAt = numberValue(audioUpload?.details?.clientStoppedAt);

  rows.push({
    createdAt: utterance.createdAt,
    text: String(utterance.text ?? '').replace(/\s+/g, ' ').trim(),
    clientSpeechDuration: seconds(clientStartedAt != null && clientStoppedAt != null ? clientStoppedAt - clientStartedAt : null),
    speechEndToUtterance: seconds(clientStoppedAt != null ? t0 - clientStoppedAt : null),
    speechEndToAgentReceived: seconds(clientStoppedAt != null && agentReceived ? agentReceived.timeMs - clientStoppedAt : null),
    speechEndToAgentStart: seconds(clientStoppedAt != null && agentStart ? agentStart.timeMs - clientStoppedAt : null),
    speechEndToFinalMessage: seconds(clientStoppedAt != null && finalMessage ? finalMessage.timeMs - clientStoppedAt : null),
    speechEndToPlaybackStart: seconds(clientStoppedAt != null && playbackStart ? playbackStart.timeMs - clientStoppedAt : null),
  });
}

const summary = summarize(rows, 'speechEndToPlaybackStart');
const currentMean = summary.mean || 0;
const currentP90 = summary.p90 || 0;

const absImprovement = baselineMean - currentMean;
const pctImprovement = baselineMean > 0 ? (absImprovement / baselineMean) * 100 : 0;
const p90AbsImprovement = baselineP90 - currentP90;
const p90PctImprovement = baselineP90 > 0 ? (p90AbsImprovement / baselineP90) * 100 : 0;

console.log(`Latency assertion against baseline:`);
console.log(`  metric: speechEndToPlaybackStart`);
console.log(`  samples: ${rows.length}; malformed: ${malformed}`);
console.log(`  baseline mean: ${baselineMean.toFixed(3)}s`);
console.log(`  current mean:  ${currentMean.toFixed(3)}s`);
console.log(`  mean delta:    ${absImprovement >= 0 ? '-' : '+'}${Math.abs(absImprovement).toFixed(3)}s`);
console.log(`  mean percent:  ${pctImprovement.toFixed(2)}%`);
console.log(`  baseline p90:  ${baselineP90.toFixed(3)}s`);
console.log(`  current p90:   ${currentP90.toFixed(3)}s`);
console.log(`  p90 delta:     ${p90AbsImprovement >= 0 ? '-' : '+'}${Math.abs(p90AbsImprovement).toFixed(3)}s`);
console.log(`  p90 percent:   ${p90PctImprovement.toFixed(2)}%`);

const checks = [];
if (targetPercent > 0) checks.push({ label: `mean improves by ${targetPercent}% or more`, pass: pctImprovement >= targetPercent });
if (targetAbsolute > 0) checks.push({ label: `mean improves by ${targetAbsolute.toFixed(3)}s or more`, pass: absImprovement >= targetAbsolute });

for (const check of checks) {
  console.log(`  check ${check.pass ? 'PASS' : 'FAIL'}: ${check.label}`);
}

if (checks.length > 0 && checks.some((check) => !check.pass)) process.exit(1);
