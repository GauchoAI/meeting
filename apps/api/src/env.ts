import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const configEnvMap: Record<string, string> = {
  sttProvider: "STT_PROVIDER",
  whisperCppBin: "WHISPER_CPP_BIN",
  whisperModelPath: "WHISPER_MODEL_PATH",
  meetingApiPort: "MEETING_API_PORT",
  meetingWebPort: "MEETING_WEB_PORT",
  meetingAgentBackend: "MEETING_AGENT_BACKEND",
  meetingWorkspaceRoot: "MEETING_WORKSPACE_ROOT",
  meetingId: "MEETING_ID",
  meetingEventLog: "MEETING_EVENT_LOG"
};

export function loadLocalConfig(): void {
  const path = [
    resolve(process.cwd(), "config/meeting.local.json"),
    resolve(process.cwd(), "../../config/meeting.local.json")
  ].find((candidate) => existsSync(candidate));
  if (!path) return;
  const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, string | number | boolean | undefined>;
  for (const [key, envName] of Object.entries(configEnvMap)) {
    const value = payload[key];
    if (value !== undefined) process.env[envName] ||= String(value);
  }
}

export function loadDotEnv(): void {
  const path = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find((candidate) => existsSync(candidate));
  if (!path) {
    return;
  }
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const [key, ...rest] = trimmed.split("=");
    process.env[key] ||= rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}

