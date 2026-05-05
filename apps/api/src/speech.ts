import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SpeechProviderStatus {
  provider: "local-whisper" | "deepgram";
  configured: boolean;
  streamingStt: boolean;
  streamingTts: false;
  settingsPath?: string;
  listenModel?: string;
  speakModel?: string;
  thinkModel?: string;
  note: string;
}

export function speechProviderStatus(): SpeechProviderStatus {
  const settings = loadDeepgramAgentSettings();
  return {
    provider: process.env.STT_PROVIDER === "deepgram" ? "deepgram" : "local-whisper",
    configured: process.env.STT_PROVIDER === "deepgram"
      ? Boolean(process.env.DEEPGRAM_API_KEY)
      : Boolean(process.env.WHISPER_CPP_BIN && process.env.WHISPER_MODEL_PATH),
    streamingStt: true,
    streamingTts: false,
    settingsPath: settings.path,
    listenModel: settings.listenModel,
    speakModel: settings.speakModel,
    thinkModel: settings.thinkModel,
    note: process.env.DEEPGRAM_API_KEY
      ? "Deepgram key detected; local Whisper remains the default STT provider unless STT_PROVIDER=deepgram."
      : "Local Whisper is the default. Run scripts/setup-whisper.cpp.sh if whisper-cli/model are missing."
  };
}

function loadDeepgramAgentSettings(): {
  path?: string;
  listenModel?: string;
  speakModel?: string;
  thinkModel?: string;
} {
  const path = process.env.DEEPGRAM_AGENT_SETTINGS_PATH;
  if (!path) {
    return {};
  }
  const resolved = [resolve(process.cwd(), path), resolve(process.cwd(), "../../", path)].find((candidate) => existsSync(candidate));
  if (!resolved) {
    return { path };
  }
  try {
    const payload = JSON.parse(readFileSync(resolved, "utf8")) as {
      agent?: {
        listen?: { provider?: { model?: string } };
        speak?: { provider?: { model?: string } };
        think?: { provider?: { model?: string } };
      };
    };
    return {
      path,
      listenModel: payload.agent?.listen?.provider?.model,
      speakModel: payload.agent?.speak?.provider?.model,
      thinkModel: payload.agent?.think?.provider?.model
    };
  } catch {
    return { path };
  }
}
