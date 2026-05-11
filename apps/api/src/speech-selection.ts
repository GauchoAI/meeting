export type SpeechMode = "live" | "narration" | "experimental";
export type SpeechSttProvider = "local-whisper" | "deepgram" | "voxtral-http" | "moshi-http" | "parakeet-http";
export type SpeechTtsProvider = "chatterbox-turbo" | "mistral-voxtral" | "mlx-voxtral" | "qwen3-tts";

export interface SpeechModeDefaults {
  sttProvider: SpeechSttProvider;
  ttsProvider: SpeechTtsProvider;
  note: string;
}

export interface SpeechSelectionStatus {
  mode: SpeechMode;
  sttProvider: SpeechSttProvider;
  ttsProvider: SpeechTtsProvider;
  defaults: Record<SpeechMode, SpeechModeDefaults>;
  overrides: {
    sttProvider?: string;
    ttsProvider?: string;
    modeSttProvider?: string;
    modeTtsProvider?: string;
  };
}

const speechModeDefaults: Record<SpeechMode, SpeechModeDefaults> = {
  live: {
    sttProvider: "parakeet-http",
    ttsProvider: "mlx-voxtral",
    note: "Fast local meeting loop: Parakeet STT plus streaming-capable MLX Voxtral TTS."
  },
  narration: {
    sttProvider: "parakeet-http",
    ttsProvider: "qwen3-tts",
    note: "Offline artifact audio: keep Parakeet STT and prefer Qwen3 when synthesis time can be hidden."
  },
  experimental: {
    sttProvider: "moshi-http",
    ttsProvider: "qwen3-tts",
    note: "Full-duplex and multilingual experiments; not the stable live meeting default."
  }
};

export function selectedSpeechMode(): SpeechMode {
  const mode = process.env.MEETING_SPEECH_MODE || process.env.SPEECH_MODE;
  if (mode === "narration" || mode === "offline") return "narration";
  if (mode === "experimental" || mode === "lab") return "experimental";
  return "live";
}

export function selectedSttProvider(): SpeechSttProvider {
  const mode = selectedSpeechMode();
  return normalizeSttProvider(process.env.STT_PROVIDER || process.env.MEETING_STT_PROVIDER || modeSttOverride(mode))
    || speechModeDefaults[mode].sttProvider;
}

export function selectedTtsProvider(): SpeechTtsProvider {
  const mode = selectedSpeechMode();
  return normalizeTtsProvider(process.env.MEETING_TTS_PROVIDER || process.env.TTS_PROVIDER || modeTtsOverride(mode))
    || speechModeDefaults[mode].ttsProvider;
}

export function speechSelectionStatus(): SpeechSelectionStatus {
  const mode = selectedSpeechMode();
  return {
    mode,
    sttProvider: selectedSttProvider(),
    ttsProvider: selectedTtsProvider(),
    defaults: speechModeDefaults,
    overrides: {
      sttProvider: process.env.STT_PROVIDER || process.env.MEETING_STT_PROVIDER,
      ttsProvider: process.env.MEETING_TTS_PROVIDER || process.env.TTS_PROVIDER,
      modeSttProvider: modeSttOverride(mode),
      modeTtsProvider: modeTtsOverride(mode)
    }
  };
}

export function normalizeSttProvider(provider: string | undefined): SpeechSttProvider | undefined {
  if (provider === "deepgram" || provider === "voxtral-http" || provider === "moshi-http" || provider === "parakeet-http") return provider;
  if (provider === "whisper" || provider === "whisper.cpp" || provider === "local-whisper") return "local-whisper";
  return undefined;
}

export function normalizeTtsProvider(provider: string | undefined): SpeechTtsProvider | undefined {
  if (provider === "mistral" || provider === "mistral-voxtral" || provider === "voxtral-tts") return "mistral-voxtral";
  if (provider === "mlx-voxtral" || provider === "voxtral-mlx" || provider === "local-voxtral-tts") return "mlx-voxtral";
  if (provider === "qwen" || provider === "qwen3" || provider === "qwen3-tts" || provider === "local-qwen3-tts") return "qwen3-tts";
  if (provider === "chatterbox" || provider === "chatterbox-turbo" || provider === "local-chatterbox") return "chatterbox-turbo";
  return undefined;
}

function modeSttOverride(mode: SpeechMode): string | undefined {
  if (mode === "narration") return process.env.MEETING_NARRATION_STT_PROVIDER;
  if (mode === "experimental") return process.env.MEETING_EXPERIMENTAL_STT_PROVIDER;
  return process.env.MEETING_LIVE_STT_PROVIDER;
}

function modeTtsOverride(mode: SpeechMode): string | undefined {
  if (mode === "narration") return process.env.MEETING_NARRATION_TTS_PROVIDER;
  if (mode === "experimental") return process.env.MEETING_EXPERIMENTAL_TTS_PROVIDER;
  return process.env.MEETING_LIVE_TTS_PROVIDER;
}
