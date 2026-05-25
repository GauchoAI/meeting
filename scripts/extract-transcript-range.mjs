#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error(`Usage: node scripts/extract-transcript-range.mjs --start ISO --end ISO --out FILE [--title TITLE]\n\nExtracts host utterances plus pi-agent spoken replies from Meeting JSONL logs into Markdown.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--start' || a === '--end' || a === '--out' || a === '--title') opts[a.slice(2)] = args[++i];
  else usage();
}
if (!opts.start || !opts.end || !opts.out) usage();

const start = new Date(opts.start).getTime();
const end = new Date(opts.end).getTime();
if (!Number.isFinite(start) || !Number.isFinite(end)) usage();

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const events = [];
for (const o of readJsonl('.meeting/pipeline/conversation/transcript/conversation.jsonl')) {
  if (o.type !== 'utterance.final') continue;
  const t = new Date(o.createdAt).getTime();
  if (t < start || t > end) continue;
  const speaker = o.speakerLabel || o.speakerId || 'Speaker';
  events.push({ ts: o.createdAt, speaker, id: o.id, text: o.text || '' });
}

for (const o of readJsonl('.meeting/pipeline/implementation/inbox/agent-dialogue.jsonl')) {
  if (o.role !== 'pi-agent' || !o.text) continue;
  const t = new Date(o.ts).getTime();
  if (t < start || t > end) continue;
  events.push({ ts: o.ts, speaker: 'Códex / pi-agent', id: o.eventId || '', text: o.text });
}

events.sort((a, b) => new Date(a.ts) - new Date(b.ts) || a.speaker.localeCompare(b.speaker));

const title = opts.title || 'Transcript extract';
let md = `# ${title}\n\n`;
md += `**Range:** ${opts.start} → ${opts.end}\n\n`;
md += `**Source files:** \`.meeting/pipeline/conversation/transcript/conversation.jsonl\`, \`.meeting/pipeline/implementation/inbox/agent-dialogue.jsonl\`\n\n`;
md += `**Events:** ${events.length}\n\n---\n\n`;
for (const e of events) {
  md += `### ${e.speaker}\n\n`;
  md += `*${e.ts}${e.id ? ` · ${e.id}` : ''}*\n\n`;
  md += `${e.text.replace(/\n{3,}/g, '\n\n')}\n\n`;
}

fs.mkdirSync(path.dirname(opts.out), { recursive: true });
fs.writeFileSync(opts.out, md);
console.log(opts.out);
