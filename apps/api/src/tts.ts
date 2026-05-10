import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type TtsProvider = "chatterbox-turbo" | "mistral-voxtral";

export interface TtsProviderStatus {
  provider: TtsProvider;
  configured: boolean;
  endpoint: string;
  model?: string;
  responseFormat?: string;
  streaming?: boolean;
  streamingResponseFormat?: string;
  pcmSampleRate?: number;
  note?: string;
}

export interface TtsSynthesisResult {
  audio: Buffer;
  contentType: string;
  provider: TtsProvider;
  endpoint: string;
  elapsedMs: number;
  upstreamElapsedMs?: string | null;
  model?: string;
  responseFormat?: string;
}

export interface TtsStreamResult {
  stream: ReadableStream<Uint8Array>;
  provider: TtsProvider;
  endpoint: string;
  model: string;
  responseFormat: "pcm";
  pcmSampleRate: number;
  elapsedMs: number;
}

export function ttsProvider(): TtsProvider {
  const provider = process.env.MEETING_TTS_PROVIDER || process.env.TTS_PROVIDER;
  if (provider === "mistral" || provider === "mistral-voxtral" || provider === "voxtral-tts") {
    return "mistral-voxtral";
  }
  return "chatterbox-turbo";
}

export function ttsProviderStatus(): TtsProviderStatus {
  const provider = ttsProvider();
  if (provider === "mistral-voxtral") {
    const config = mistralTtsConfig();
    return {
      provider,
      configured: Boolean(config.apiKey) || isLocalEndpoint(config.endpoint),
      endpoint: config.endpoint,
      model: config.model,
      responseFormat: config.responseFormat,
      streaming: Boolean(config.apiKey) || isLocalEndpoint(config.endpoint),
      streamingResponseFormat: "pcm",
      pcmSampleRate: config.pcmSampleRate,
      note: config.apiKey
        ? "Mistral Voxtral TTS API key detected."
        : "Set MISTRAL_API_KEY for hosted Voxtral TTS, or point MISTRAL_TTS_BASE_URL at a local compatible server."
    };
  }
  return {
    provider,
    configured: true,
    endpoint: chatterboxEndpoint(),
    streaming: false,
    note: "Local Chatterbox Turbo TTS HTTP worker."
  };
}

export function streamingTtsSupported(): boolean {
  const status = ttsProviderStatus();
  return status.provider === "mistral-voxtral" && status.configured && Boolean(status.streaming);
}

export async function synthesizeSpeech(text: string): Promise<TtsSynthesisResult> {
  const provider = ttsProvider();
  if (provider === "mistral-voxtral") return synthesizeMistralVoxtral(text);
  return synthesizeChatterbox(text);
}

export async function streamSpeech(text: string): Promise<TtsStreamResult> {
  const provider = ttsProvider();
  if (provider !== "mistral-voxtral") {
    throw new TtsProviderError(provider, 409, "Streaming TTS requires MEETING_TTS_PROVIDER=mistral-voxtral.", 0);
  }
  return streamMistralVoxtral(text);
}

function chatterboxEndpoint(): string {
  return process.env.CHATTERBOX_TTS_URL || process.env.MEETING_TTS_URL || "http://127.0.0.1:8791/synthesize";
}

async function synthesizeChatterbox(text: string): Promise<TtsSynthesisResult> {
  const endpoint = chatterboxEndpoint();
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  const elapsedMs = Date.now() - startedAt;
  const contentTypeHeader = response.headers.get("content-type") || "";
  if (!response.ok) {
    const body = await response.text();
    throw new TtsProviderError("chatterbox-turbo", response.status, body || `local TTS returned ${response.status}`, elapsedMs);
  }
  return {
    audio: Buffer.from(await response.arrayBuffer()),
    contentType: contentTypeHeader.includes("audio/") ? contentTypeHeader : "audio/wav",
    provider: "chatterbox-turbo",
    endpoint,
    elapsedMs,
    upstreamElapsedMs: response.headers.get("x-tts-elapsed-ms")
  };
}

function mistralTtsConfig(): {
  endpoint: string;
  apiKey?: string;
  model: string;
  responseFormat: "wav" | "mp3" | "flac" | "opus" | "pcm";
  voiceId?: string;
  refAudio?: string;
  pcmSampleRate: number;
} {
  const baseUrl = trimTrailingSlash(process.env.MISTRAL_TTS_BASE_URL || process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1");
  const responseFormat = normalizeResponseFormat(process.env.MISTRAL_TTS_RESPONSE_FORMAT || "wav");
  return {
    endpoint: process.env.MISTRAL_TTS_URL || `${baseUrl}/audio/speech`,
    apiKey: process.env.MISTRAL_TTS_API_KEY || process.env.MISTRAL_API_KEY,
    model: process.env.MISTRAL_TTS_MODEL || "voxtral-mini-tts-2603",
    responseFormat,
    voiceId: process.env.MISTRAL_TTS_VOICE_ID || process.env.MISTRAL_VOICE_ID,
    refAudio: readReferenceAudio(),
    pcmSampleRate: Number(process.env.MISTRAL_TTS_PCM_SAMPLE_RATE || 24_000)
  };
}

async function synthesizeMistralVoxtral(text: string): Promise<TtsSynthesisResult> {
  const config = mistralTtsConfig();
  if (!config.apiKey && !isLocalEndpoint(config.endpoint)) {
    throw new TtsProviderError("mistral-voxtral", 0, "MISTRAL_API_KEY is required for hosted Voxtral TTS.", 0);
  }

  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: config.model,
    input: text,
    response_format: config.responseFormat,
    stream: false
  };
  if (config.voiceId) body.voice_id = config.voiceId;
  if (config.refAudio) body.ref_audio = config.refAudio;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const elapsedMs = Date.now() - startedAt;
  const responseContentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const errorBody = await response.text();
    throw new TtsProviderError("mistral-voxtral", response.status, errorBody || `Mistral TTS returned ${response.status}`, elapsedMs);
  }

  const { audio, contentType } = responseContentType.includes("application/json")
    ? await readMistralJsonAudio(response, config.responseFormat, config.pcmSampleRate)
    : {
      audio: Buffer.from(await response.arrayBuffer()),
      contentType: responseContentType.includes("audio/") ? responseContentType : contentTypeForFormat(config.responseFormat)
    };

  return {
    audio,
    contentType,
    provider: "mistral-voxtral",
    endpoint: config.endpoint,
    elapsedMs,
    model: config.model,
    responseFormat: config.responseFormat
  };
}

async function streamMistralVoxtral(text: string): Promise<TtsStreamResult> {
  const config = mistralTtsConfig();
  if (!config.apiKey && !isLocalEndpoint(config.endpoint)) {
    throw new TtsProviderError("mistral-voxtral", 0, "MISTRAL_API_KEY is required for hosted Voxtral TTS streaming.", 0);
  }

  const startedAt = Date.now();
  const body: Record<string, unknown> = {
    model: config.model,
    input: text,
    response_format: "pcm",
    stream: true
  };
  if (config.voiceId) body.voice_id = config.voiceId;
  if (config.refAudio) body.ref_audio = config.refAudio;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream"
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const elapsedMs = Date.now() - startedAt;
  if (!response.ok) {
    const errorBody = await response.text();
    throw new TtsProviderError("mistral-voxtral", response.status, errorBody || `Mistral streaming TTS returned ${response.status}`, elapsedMs);
  }
  if (!response.body) {
    throw new TtsProviderError("mistral-voxtral", 502, "Mistral streaming TTS response did not include a stream body.", elapsedMs);
  }

  return {
    stream: response.body,
    provider: "mistral-voxtral",
    endpoint: config.endpoint,
    elapsedMs,
    model: config.model,
    responseFormat: "pcm",
    pcmSampleRate: config.pcmSampleRate
  };
}

async function readMistralJsonAudio(response: Response, responseFormat: string, pcmSampleRate: number): Promise<{ audio: Buffer; contentType: string }> {
  const payload = await response.json() as { audio_data?: string };
  if (!payload.audio_data) {
    throw new TtsProviderError("mistral-voxtral", 502, "Mistral TTS response did not include audio_data.", 0);
  }
  const audio = Buffer.from(payload.audio_data, "base64");
  if (responseFormat === "pcm") {
    return { audio: wavFromFloat32Pcm(audio, pcmSampleRate), contentType: "audio/wav" };
  }
  return { audio, contentType: contentTypeForFormat(responseFormat) };
}

function readReferenceAudio(): string | undefined {
  if (process.env.MISTRAL_TTS_REF_AUDIO_BASE64) return process.env.MISTRAL_TTS_REF_AUDIO_BASE64;
  const audioPath = process.env.MISTRAL_TTS_REF_AUDIO_PATH;
  if (!audioPath) return undefined;
  const resolved = resolve(process.cwd(), audioPath);
  if (!existsSync(resolved)) return undefined;
  return readFileSync(resolved).toString("base64");
}

function contentTypeForFormat(format: string): string {
  if (format === "mp3") return "audio/mpeg";
  if (format === "flac") return "audio/flac";
  if (format === "opus") return "audio/ogg; codecs=opus";
  return "audio/wav";
}

function normalizeResponseFormat(value: string): "wav" | "mp3" | "flac" | "opus" | "pcm" {
  if (value === "mp3" || value === "flac" || value === "opus" || value === "pcm") return value;
  return "wav";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLocalEndpoint(endpoint: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(endpoint);
}

function wavFromFloat32Pcm(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 32;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class TtsProviderError extends Error {
  constructor(
    public readonly provider: TtsProvider,
    public readonly status: number,
    message: string,
    public readonly elapsedMs: number
  ) {
    super(message);
  }
}
