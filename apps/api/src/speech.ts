import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { streamingTtsSupported, ttsProviderStatus, type TtsProviderStatus } from "./tts.js";

export interface SpeechProviderStatus {
  provider: "local-whisper" | "deepgram" | "voxtral-http" | "moshi-http";
  configured: boolean;
  streamingStt: boolean;
  streamingTts: boolean;
  localTts?: TtsProviderStatus;
  settingsPath?: string;
  listenModel?: string;
  speakModel?: string;
  thinkModel?: string;
  note: string;
}

export function speechProviderStatus(): SpeechProviderStatus {
  const settings = loadDeepgramAgentSettings();
  const provider = speechProvider();
  return {
    provider,
    configured: speechProviderConfigured(provider),
    streamingStt: streamingSttSupported(provider),
    streamingTts: streamingTtsSupported(),
    localTts: localTtsStatus(),
    settingsPath: settings.path,
    listenModel: localListenModel(provider) || settings.listenModel,
    speakModel: settings.speakModel,
    thinkModel: settings.thinkModel,
    note: speechProviderNote(provider)
  };
}

function localTtsStatus(): SpeechProviderStatus["localTts"] {
  return ttsProviderStatus();
}

function speechProvider(): SpeechProviderStatus["provider"] {
  const provider = process.env.STT_PROVIDER;
  if (provider === "deepgram" || provider === "voxtral-http" || provider === "moshi-http") return provider;
  return "local-whisper";
}

function speechProviderConfigured(provider: SpeechProviderStatus["provider"]): boolean {
  if (provider === "deepgram") return Boolean(process.env.DEEPGRAM_API_KEY);
  if (provider === "voxtral-http") return Boolean(process.env.VOXTRAL_STT_URL || process.env.STT_PROVIDER === "voxtral-http");
  if (provider === "moshi-http") return Boolean(process.env.MOSHI_STT_URL || process.env.STT_PROVIDER === "moshi-http");
  return Boolean(process.env.WHISPER_SERVER_URL || (process.env.WHISPER_CPP_BIN && process.env.WHISPER_MODEL_PATH));
}

function streamingSttSupported(provider: SpeechProviderStatus["provider"]): boolean {
  return provider === "deepgram" || provider === "moshi-http";
}

function localListenModel(provider: SpeechProviderStatus["provider"]): string | undefined {
  if (provider === "voxtral-http") return process.env.VOXTRAL_STT_MODEL || "mistralai/Voxtral-Mini-4B-Realtime-2602";
  if (provider === "moshi-http") return process.env.MOSHI_STT_MODEL || "kyutai/moshika-mlx-bf16";
  if (provider === "local-whisper") return process.env.WHISPER_MODEL_PATH;
  return undefined;
}

function speechProviderNote(provider: SpeechProviderStatus["provider"]): string {
  if (provider === "deepgram") return process.env.DEEPGRAM_API_KEY ? "Deepgram key detected." : "Set DEEPGRAM_API_KEY for Deepgram STT.";
  if (provider === "voxtral-http") return `Experimental local Voxtral STT over HTTP at ${process.env.VOXTRAL_STT_URL || "http://localhost:8787/transcribe"}.`;
  if (provider === "moshi-http") return `Experimental Moshi bridge over HTTP at ${process.env.MOSHI_STT_URL || "http://localhost:8788/transcribe"}. Moshi is for full-duplex voice experiments, not durable tool use.`;
  if (process.env.WHISPER_SERVER_URL) return `Local Whisper server detected at ${process.env.WHISPER_SERVER_URL}; using preloaded model path when available.`;
  return process.env.DEEPGRAM_API_KEY
    ? "Deepgram key detected; local Whisper remains the default STT provider unless STT_PROVIDER=deepgram."
    : "Local Whisper is the default. Run scripts/setup-whisper.cpp.sh if whisper-cli/model are missing.";
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
