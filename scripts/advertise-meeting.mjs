#!/usr/bin/env node
const args = process.argv.slice(2);
function value(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
function flag(name) { return args.includes(name); }

const databaseUrl = (value('--database', process.env.VITE_FIREBASE_DATABASE_URL) || 'https://signaling-dcfad-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/+$/, '');
const namespace = (value('--namespace', process.env.VITE_FIREBASE_NAMESPACE) || 'gauchoai-meeting').replace(/^\/+|\/+$/g, '');
const meetingId = value('--meeting', 'core');
const title = value('--title', 'Core Meeting');
const hostName = value('--host', 'Miguel');
const hostId = value('--host-id', 'host');
const apiUrl = value('--api', 'http://localhost:4317');
const intervalMs = Math.max(5000, Number(value('--interval-ms', '10000')) || 10000);
const once = flag('--once');

function cleanKey(text) { return encodeURIComponent(String(text)).replace(/\./g, '%2E'); }
const url = `${databaseUrl}/${namespace}/publicMeetings/${cleanKey(meetingId)}.json`;

async function publish() {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      host: { id: hostId, name: hostName },
      apiUrl,
      signalingRoomId: meetingId,
      visibility: 'public',
      participantCount: 1,
      updatedAtMs: Date.now()
    })
  });
  if (!response.ok) throw new Error(`advertise failed: ${response.status} ${await response.text()}`);
  console.log(`[advertise] ${title} (${meetingId}) -> ${url}`);
}

async function remove() {
  await fetch(url, { method: 'DELETE' }).catch(() => undefined);
  console.log(`[advertise] removed ${meetingId}`);
}

process.on('SIGINT', () => { void remove().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void remove().finally(() => process.exit(0)); });

await publish();
if (!once) setInterval(() => void publish().catch((error) => console.error(error)), intervalMs);
