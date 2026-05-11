import { transcribeWithLocalWhisper } from "./local-whisper.js";

export type LocalSttProvider = "local-whisper" | "voxtral-http" | "moshi-http" | "parakeet-http";

export interface LocalSttResult {
  text: string;
  provider: LocalSttProvider;
  elapsedMs: number;
  model?: string;
  modelPath?: string;
  endpoint?: string;
}

export function currentLocalSttProvider(): LocalSttProvider {
  const provider = process.env.STT_PROVIDER;
  if (provider === "voxtral-http" || provider === "moshi-http" || provider === "parakeet-http") return provider;
  return "local-whisper";
}

export async function transcribeLocalAudio(input: Buffer, extension: string): Promise<LocalSttResult> {
  const provider = currentLocalSttProvider();
  if (provider === "local-whisper") return transcribeWithLocalWhisper(input, extension);
  return transcribeWithHttpStt(provider, input, extension);
}

async function transcribeWithHttpStt(provider: Exclude<LocalSttProvider, "local-whisper">, input: Buffer, extension: string): Promise<LocalSttResult> {
  const started = Date.now();
  const endpoint = sttEndpoint(provider);
  const url = new URL(endpoint);
  if (!url.searchParams.has("extension")) url.searchParams.set("extension", extension || "webm");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `audio/${extension || "webm"}` },
    body: new Uint8Array(input)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${provider} returned ${response.status}: ${body.slice(0, 1000)}`);
  const parsed = parseSttResponse(body);
  return {
    text: parsed.text,
    provider,
    endpoint,
    model: parsed.model,
    elapsedMs: parsed.elapsedMs ?? Date.now() - started
  };
}

function sttEndpoint(provider: Exclude<LocalSttProvider, "local-whisper">): string {
  if (provider === "voxtral-http") return process.env.VOXTRAL_STT_URL || "http://localhost:8787/transcribe";
  if (provider === "moshi-http") return process.env.MOSHI_STT_URL || "http://localhost:8788/transcribe";
  return process.env.PARAKEET_STT_URL || "http://localhost:8793/transcribe";
}

function parseSttResponse(body: string): { text: string; model?: string; elapsedMs?: number } {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const nestedResult = json.result && typeof json.result === "object" ? json.result as Record<string, unknown> : {};
    const text = stringField(json.text)
      || stringField(json.transcript)
      || stringField(json.output)
      || stringField(nestedResult.text)
      || stringField(nestedResult.transcript)
      || "";
    return {
      text: text.trim(),
      model: stringField(json.model) || stringField(nestedResult.model),
      elapsedMs: numberField(json.elapsedMs) ?? numberField(json.elapsed_ms) ?? numberField(nestedResult.elapsedMs)
    };
  } catch {
    return { text: body.trim() };
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
