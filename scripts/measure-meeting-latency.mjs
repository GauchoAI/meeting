#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
function hasFlag(name) {
  return args.includes(name);
}

const file = argValue('--file', '.meeting/events.jsonl');
const tailMb = Number(argValue('--tail-mb', '80'));
const sinceArg = argValue('--since', null);
const windowSeconds = Number(argValue('--window-s', '60'));
const sttLookbackSeconds = Number(argValue('--stt-lookback-s', '15'));
const speaker = argValue('--speaker', 'Host');
const limit = Number(argValue('--limit', '25'));
const jsonOut = hasFlag('--json');

function parseTime(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`Invalid timestamp: ${value}`);
  return t;
}
function seconds(ms) {
  return ms == null ? null : ms / 1000;
}
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function fmt(value) {
  return value == null ? '—' : `${value.toFixed(3)}s`;
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}
function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function median(values) {
  return percentile(values, 0.5);
}
function summarize(rows, key) {
  const values = rows.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : null,
    median: median(values),
    mean: mean(values),
    p90: percentile(values, 0.9),
    max: values.length ? Math.max(...values) : null,
  };
}

function readJsonlTail(filePath, mb) {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs);
  const bytes = Math.max(1, Math.floor(mb * 1024 * 1024));
  const start = Math.max(0, stat.size - bytes);
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // If we started mid-line, drop the partial first line.
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

const since = sinceArg ? parseTime(sinceArg) : null;
const raw = readJsonlTail(file, tailMb);
const events = [];
let malformed = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  try {
    const event = JSON.parse(line);
    if (!event.createdAt) continue;
    const timeMs = parseTime(event.createdAt);
    if (since != null && timeMs < since) continue;
    events.push({ ...event, timeMs });
  } catch {
    malformed += 1;
  }
}
events.sort((a, b) => a.timeMs - b.timeMs);

const rows = [];
for (let i = 0; i < events.length; i += 1) {
  const utterance = events[i];
  if (utterance.type !== 'utterance.final') continue;
  if (utterance.speakerLabel !== speaker) continue;

  const t0 = utterance.timeMs;
  const previous = [];
  for (let j = i - 1; j >= 0; j -= 1) {
    const dt = (t0 - events[j].timeMs) / 1000;
    if (dt > sttLookbackSeconds) break;
    previous.push(events[j]);
  }
  const following = [];
  for (let j = i + 1; j < events.length; j += 1) {
    const dt = (events[j].timeMs - t0) / 1000;
    if (dt > windowSeconds) break;
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
  const clientStartedAt = numberValue(audioUpload?.details?.clientStartedAt);
  const clientStoppedAt = numberValue(audioUpload?.details?.clientStoppedAt);

  rows.push({
    createdAt: utterance.createdAt,
    text: String(utterance.text ?? '').replace(/\s+/g, ' ').trim(),
    clientSpeechDuration: seconds(clientStartedAt != null && clientStoppedAt != null ? clientStoppedAt - clientStartedAt : null),
    audioUploadToUtterance: seconds(audioUpload ? t0 - audioUpload.timeMs : null),
    speechEndToUtterance: seconds(clientStoppedAt != null ? t0 - clientStoppedAt : null),
    sttStartToUtterance: seconds(sttStart ? t0 - sttStart.timeMs : null),
    sttEndToUtterance: seconds(sttEnd ? t0 - sttEnd.timeMs : null),
    utteranceToAgentReceived: seconds(agentReceived ? agentReceived.timeMs - t0 : null),
    utteranceToAgentStart: seconds(agentStart ? agentStart.timeMs - t0 : null),
    utteranceToFinalMessage: seconds(finalMessage ? finalMessage.timeMs - t0 : null),
    utteranceToTtsStart: seconds(ttsStart ? ttsStart.timeMs - t0 : null),
    utteranceToTtsEnd: seconds(ttsEnd ? ttsEnd.timeMs - t0 : null),
    speechEndToAgentReceived: seconds(clientStoppedAt != null && agentReceived ? agentReceived.timeMs - clientStoppedAt : null),
    speechEndToAgentStart: seconds(clientStoppedAt != null && agentStart ? agentStart.timeMs - clientStoppedAt : null),
    speechEndToFinalMessage: seconds(clientStoppedAt != null && finalMessage ? finalMessage.timeMs - clientStoppedAt : null),
    speechEndToTtsStart: seconds(clientStoppedAt != null && ttsStart ? ttsStart.timeMs - clientStoppedAt : null),
    speechEndToPlaybackStart: seconds(clientStoppedAt != null && playbackStart ? playbackStart.timeMs - clientStoppedAt : null),
    speechEndToTtsEnd: seconds(clientStoppedAt != null && ttsEnd ? ttsEnd.timeMs - clientStoppedAt : null),
  });
}

const summaryKeys = [
  'clientSpeechDuration',
  'audioUploadToUtterance',
  'speechEndToUtterance',
  'sttStartToUtterance',
  'sttEndToUtterance',
  'utteranceToAgentReceived',
  'utteranceToAgentStart',
  'utteranceToFinalMessage',
  'utteranceToTtsStart',
  'utteranceToTtsEnd',
  'speechEndToAgentReceived',
  'speechEndToAgentStart',
  'speechEndToFinalMessage',
  'speechEndToTtsStart',
  'speechEndToPlaybackStart',
  'speechEndToTtsEnd',
];
const summary = Object.fromEntries(summaryKeys.map((key) => [key, summarize(rows, key)]));

if (jsonOut) {
  console.log(JSON.stringify({ file, tailMb, since: sinceArg, speaker, windowSeconds, sttLookbackSeconds, malformed, utterances: rows.length, summary, rows }, null, 2));
  process.exit(0);
}

console.log(`Meeting latency report`);
console.log(`file: ${file}`);
console.log(`speaker: ${speaker}`);
console.log(`tail: ${tailMb} MiB; since: ${sinceArg ?? '(not set)'}; response window: ${windowSeconds}s`);
console.log(`parsed events: ${events.length}; malformed lines skipped: ${malformed}; utterances: ${rows.length}`);
console.log('');
console.log('Summary:');
for (const key of summaryKeys) {
  const s = summary[key];
  console.log(`  ${key.padEnd(26)} n=${String(s.n).padStart(3)} median=${fmt(s.median).padStart(8)} mean=${fmt(s.mean).padStart(8)} p90=${fmt(s.p90).padStart(8)} min=${fmt(s.min).padStart(8)} max=${fmt(s.max).padStart(8)}`);
}
console.log('');
console.log(`Last ${Math.min(limit, rows.length)} utterances:`);
const shown = rows.slice(Math.max(0, rows.length - limit));
for (const r of shown) {
  const time = r.createdAt.replace(/^.*T/, '').replace('Z', 'Z');
  const text = r.text.length > 86 ? `${r.text.slice(0, 83)}...` : r.text;
  console.log(`  ${time}  speechEnd→play=${fmt(r.speechEndToPlaybackStart)}  speechEnd→tts=${fmt(r.speechEndToTtsStart)}  audio→utt=${fmt(r.audioUploadToUtterance)}  utt→final=${fmt(r.utteranceToFinalMessage)}  ${text}`);
}
console.log('');
console.log('Notes:');
console.log('  audio→utt measures from audio.upload.received to utterance.final, not from the first spoken phoneme.');
console.log('  speechEnd→* uses browser clientStoppedAt from new stable-shell events; older logs show — for these fields.');
console.log('  speechEnd→play is the closest human-perceived metric: host speech stop to first local TTS playback trace.');
console.log('  utt→final/tts includes model reasoning and tool calls. Longer tool/image/log operations are expected outliers.');
console.log('  If the agent is already busy, an utterance may be queued and may not have a fresh agent_start in the window.');
