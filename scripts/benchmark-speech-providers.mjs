#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
loadLocalConfig();
loadDotEnv();

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = resolveRepoPath(args.outputDir || join(".meeting", "tmp", "speech-provider-benchmarks", runId));
const audioRoot = join(outputRoot, "audio");
const fixtureRoot = join(outputRoot, "stt-fixtures");
const timeoutMs = Number(args.timeoutMs || process.env.SPEECH_BENCHMARK_TIMEOUT_MS || 120_000);
const streamIdleMs = Number(args.streamIdleMs || process.env.SPEECH_BENCHMARK_STREAM_IDLE_MS || 2_000);
const repeatCount = Math.max(1, Number(args.repeat || process.env.SPEECH_BENCHMARK_REPEAT || 1));

mkdirSync(audioRoot, { recursive: true });
mkdirSync(fixtureRoot, { recursive: true });

const ttsTexts = {
  english: "Please summarize the action items, mention API latency, Docker cache status, and the pull request owner.",
  spanish: "Por favor resume los pendientes, menciona la latencia de la API, la cache de Docker y quien revisa el pull request.",
  russian: "Пожалуйста, подведи итоги задач, упомяни задержку API, кеш Docker и ответственного за pull request."
};

const sttScenarios = [
  {
    id: "short-dictation",
    category: "short-dictation",
    language: "english",
    voice: process.env.SPEECH_BENCHMARK_ENGLISH_VOICE || "Samantha",
    text: "Please add a note that the standup moved to three PM."
  },
  {
    id: "continuous-conversation-01",
    category: "continuous-conversation",
    language: "english",
    voice: process.env.SPEECH_BENCHMARK_ENGLISH_VOICE || "Samantha",
    text: "I want to keep talking for a longer meeting turn. First, the API worker restarted, then the Docker cache was reused, and now we need Codex to prepare a concise pull request summary."
  },
  {
    id: "continuous-conversation-02",
    category: "continuous-conversation",
    language: "english",
    voice: process.env.SPEECH_BENCHMARK_ENGLISH_VOICE || "Samantha",
    text: "The second chunk continues the same thought. If the transcript drops this part, the meeting agent will miss the decision about keeping Parakeet as the default speech recognizer."
  },
  {
    id: "barge-in-stop",
    category: "interruption-barge-in",
    language: "english",
    voice: process.env.SPEECH_BENCHMARK_ENGLISH_VOICE || "Samantha",
    text: "Wait, stop. I need to interrupt the agent before it keeps speaking."
  },
  {
    id: "multilingual-technical-terms",
    category: "multilingual-technical-terms",
    language: "english",
    voice: process.env.SPEECH_BENCHMARK_ENGLISH_VOICE || "Samantha",
    text: "Please verify Kubernetes, WebRTC, Parakeet STT, Qwen three TTS, Voxtral MLX, TypeScript, and pnpm typecheck."
  },
  {
    id: "spanish-technical-terms",
    category: "multilingual-technical-terms",
    language: "spanish",
    voice: process.env.SPEECH_BENCHMARK_SPANISH_VOICE || "Mónica",
    text: "Necesitamos revisar WebRTC, Parakeet STT, Qwen tres TTS, Voxtral MLX y el typecheck de TypeScript."
  },
  {
    id: "russian-technical-terms",
    category: "multilingual-technical-terms",
    language: "russian",
    voice: process.env.SPEECH_BENCHMARK_RUSSIAN_VOICE || "Milena",
    text: "Нужно проверить WebRTC, Parakeet STT, Qwen три TTS, Voxtral MLX и TypeScript typecheck."
  }
];

const ttsProviders = [
  chatterboxTtsProvider(),
  mlxVoxtralTtsProvider(),
  qwen3TtsProvider(),
  mistralVoxtralTtsProvider()
].filter(Boolean);

const sttProviders = [
  localWhisperSttProvider(),
  parakeetSttProvider(),
  voxtralSttProvider(),
  moshiSttProvider()
];

const selectedTtsProviders = selectProviders(ttsProviders, args.tts);
const selectedSttProviders = selectProviders(sttProviders, args.stt);

const run = {
  runId,
  startedAt: new Date().toISOString(),
  repoRoot,
  outputRoot,
  timeoutMs,
  streamIdleMs,
  repeatCount,
  tools: {
    ffmpeg: commandPath("ffmpeg"),
    ffprobe: commandPath("ffprobe"),
    say: commandPath("say"),
    sox: commandPath("sox"),
    whisperCli: commandPath(process.env.WHISPER_CPP_BIN || "whisper-cli")
  },
  config: {
    speechMode: process.env.MEETING_SPEECH_MODE || "live",
    sttProvider: process.env.STT_PROVIDER || null,
    ttsProvider: process.env.MEETING_TTS_PROVIDER || process.env.TTS_PROVIDER || null,
    liveTtsProvider: process.env.MEETING_LIVE_TTS_PROVIDER || null,
    narrationTtsProvider: process.env.MEETING_NARRATION_TTS_PROVIDER || null,
    experimentalTtsProvider: process.env.MEETING_EXPERIMENTAL_TTS_PROVIDER || null
  },
  tts: [],
  stt: []
};

for (const provider of selectedTtsProviders) {
  const health = await checkHealth(provider);
  for (const [language, text] of Object.entries(ttsTexts)) {
    for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
      run.tts.push(await benchmarkTtsProvider(provider, "full-file", language, text, repeat, health));
      if (provider.streaming) {
        run.tts.push(await benchmarkTtsProvider(provider, "stream", language, text, repeat, health));
      }
    }
  }
}

const fixtures = await prepareSttFixtures(sttScenarios);
for (const provider of selectedSttProviders) {
  const health = await checkHealth(provider);
  for (const scenario of sttScenarios) {
    for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
      run.stt.push(await benchmarkSttProvider(provider, scenario, fixtures.get(scenario.id), repeat, health));
    }
  }
}

run.completedAt = new Date().toISOString();
run.summary = summarizeRun(run);

const jsonPath = join(outputRoot, "speech-provider-benchmark.json");
const markdownPath = join(outputRoot, "speech-provider-benchmark.md");
writeFileSync(jsonPath, JSON.stringify(run, null, 2));
writeFileSync(markdownPath, renderMarkdown(run));

console.log(`Speech benchmark written to ${jsonPath}`);
console.log(`Summary written to ${markdownPath}`);
printConsoleSummary(run);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      parsed[toCamel(arg.slice(2, eq))] = arg.slice(eq + 1);
    } else {
      const key = toCamel(arg.slice(2));
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        parsed[key] = next;
        index += 1;
      } else {
        parsed[key] = "true";
      }
    }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function selectProviders(providers, value) {
  if (!value || value === "all") return providers;
  const wanted = new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  return providers.filter((provider) => wanted.has(provider.id));
}

function loadLocalConfig() {
  const path = [resolve(repoRoot, "config/meeting.local.json")].find((candidate) => existsSync(candidate));
  if (!path) return;
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const map = {
    sttProvider: "STT_PROVIDER",
    ttsProvider: "MEETING_TTS_PROVIDER",
    speechMode: "MEETING_SPEECH_MODE",
    liveSttProvider: "MEETING_LIVE_STT_PROVIDER",
    liveTtsProvider: "MEETING_LIVE_TTS_PROVIDER",
    narrationSttProvider: "MEETING_NARRATION_STT_PROVIDER",
    narrationTtsProvider: "MEETING_NARRATION_TTS_PROVIDER",
    experimentalSttProvider: "MEETING_EXPERIMENTAL_STT_PROVIDER",
    experimentalTtsProvider: "MEETING_EXPERIMENTAL_TTS_PROVIDER",
    whisperCppBin: "WHISPER_CPP_BIN",
    whisperModelPath: "WHISPER_MODEL_PATH",
    whisperServerUrl: "WHISPER_SERVER_URL",
    parakeetSttUrl: "PARAKEET_STT_URL",
    voxtralSttUrl: "VOXTRAL_STT_URL",
    moshiSttUrl: "MOSHI_STT_URL",
    chatterboxTtsUrl: "CHATTERBOX_TTS_URL",
    voxtralMlxTtsUrl: "VOXTRAL_MLX_TTS_URL",
    qwen3TtsUrl: "QWEN3_TTS_URL"
  };
  for (const [key, envName] of Object.entries(map)) {
    if (payload[key] !== undefined) process.env[envName] ||= String(payload[key]);
  }
}

function loadDotEnv() {
  const path = resolve(repoRoot, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key] = rest.join("=").replace(/^['"]|['"]$/g, "");
  }
}

function resolveRepoPath(path) {
  return path.startsWith("/") ? path : resolve(repoRoot, path);
}

function chatterboxTtsProvider() {
  return {
    kind: "tts",
    id: "chatterbox-turbo",
    endpoint: process.env.CHATTERBOX_TTS_URL || process.env.MEETING_TTS_URL || "http://127.0.0.1:8791/synthesize",
    healthUrl: endpointSibling(process.env.CHATTERBOX_TTS_URL || process.env.MEETING_TTS_URL || "http://127.0.0.1:8791/synthesize", "/health"),
    model: process.env.CHATTERBOX_TTS_MODEL || "chatterbox-turbo",
    streaming: false,
    request(language, text) {
      return {
        url: this.endpoint,
        body: { text, language },
        expectedFormat: "wav"
      };
    }
  };
}

function mlxVoxtralTtsProvider() {
  const endpoint = process.env.VOXTRAL_MLX_TTS_URL || "http://127.0.0.1:8792/v1/audio/speech";
  const model = process.env.VOXTRAL_MLX_TTS_MODEL || "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit";
  const defaultVoice = process.env.VOXTRAL_MLX_TTS_VOICE || "casual_male";
  const spanishVoice = process.env.VOXTRAL_MLX_TTS_SPANISH_VOICE || "es_male";
  const pcmSampleRate = Number(process.env.VOXTRAL_MLX_TTS_PCM_SAMPLE_RATE || 24_000);
  return {
    kind: "tts",
    id: "mlx-voxtral",
    endpoint,
    healthUrl: endpointSibling(endpoint, "/health"),
    model,
    streaming: true,
    pcmSampleRate,
    request(language, text, mode) {
      const streaming = mode === "stream";
      return {
        url: endpoint,
        body: {
          model,
          input: text,
          voice: language === "spanish" ? spanishVoice : defaultVoice,
          response_format: streaming ? "pcm" : (process.env.VOXTRAL_MLX_TTS_RESPONSE_FORMAT || "wav"),
          stream: streaming,
          streaming_interval: Number(process.env.VOXTRAL_MLX_TTS_STREAMING_INTERVAL || 0.32),
          max_tokens: Number(process.env.VOXTRAL_MLX_TTS_MAX_TOKENS || 900),
          temperature: Number(process.env.VOXTRAL_MLX_TTS_TEMPERATURE || 0.8)
        },
        expectedFormat: streaming ? "pcm_s16le" : "wav",
        pcmSampleRate
      };
    }
  };
}

function qwen3TtsProvider() {
  return {
    kind: "tts",
    id: "qwen3-tts",
    endpoint: process.env.QWEN3_TTS_URL || "http://127.0.0.1:8794/synthesize",
    healthUrl: endpointSibling(process.env.QWEN3_TTS_URL || "http://127.0.0.1:8794/synthesize", "/health"),
    model: process.env.QWEN3_TTS_MODEL || "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    streaming: false,
    request(language, text) {
      return {
        url: this.endpoint,
        body: { text, input: text, language },
        expectedFormat: "wav"
      };
    }
  };
}

function mistralVoxtralTtsProvider() {
  const baseUrl = trimTrailingSlash(process.env.MISTRAL_TTS_BASE_URL || process.env.MISTRAL_BASE_URL || "https://api.mistral.ai/v1");
  const endpoint = process.env.MISTRAL_TTS_URL || `${baseUrl}/audio/speech`;
  const apiKey = process.env.MISTRAL_TTS_API_KEY || process.env.MISTRAL_API_KEY;
  if (!apiKey && !isLocalEndpoint(endpoint) && !process.env.SPEECH_BENCHMARK_INCLUDE_HOSTED) return null;
  const model = process.env.MISTRAL_TTS_MODEL || "voxtral-mini-tts-2603";
  const pcmSampleRate = Number(process.env.MISTRAL_TTS_PCM_SAMPLE_RATE || 24_000);
  return {
    kind: "tts",
    id: "mistral-voxtral",
    endpoint,
    healthUrl: null,
    model,
    streaming: Boolean(apiKey) || isLocalEndpoint(endpoint),
    pcmSampleRate,
    request(language, text, mode) {
      const streaming = mode === "stream";
      const body = {
        model,
        input: text,
        response_format: streaming ? "pcm" : (process.env.MISTRAL_TTS_RESPONSE_FORMAT || "wav"),
        stream: streaming
      };
      if (process.env.MISTRAL_TTS_VOICE_ID || process.env.MISTRAL_VOICE_ID) body.voice_id = process.env.MISTRAL_TTS_VOICE_ID || process.env.MISTRAL_VOICE_ID;
      return {
        url: endpoint,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body,
        expectedFormat: streaming ? "pcm_f32le_or_sse" : body.response_format,
        pcmSampleRate
      };
    }
  };
}

function localWhisperSttProvider() {
  return {
    kind: "stt",
    id: "local-whisper",
    endpoint: process.env.WHISPER_SERVER_URL || null,
    healthUrl: process.env.WHISPER_SERVER_URL ? endpointSibling(process.env.WHISPER_SERVER_URL, "/health") : null,
    model: process.env.WHISPER_MODEL_PATH || "models/ggml-small.bin",
    async transcribe(fixture) {
      if (process.env.WHISPER_SERVER_URL) return transcribeWhisperServer(fixture);
      return transcribeWhisperCli(fixture);
    }
  };
}

function parakeetSttProvider() {
  return httpSttProvider("parakeet-http", process.env.PARAKEET_STT_URL || "http://localhost:8793/transcribe", process.env.PARAKEET_STT_MODEL || "parakeet-tdt-0.6b-v3-int8");
}

function voxtralSttProvider() {
  return httpSttProvider("voxtral-http", process.env.VOXTRAL_STT_URL || "http://localhost:8787/transcribe", process.env.VOXTRAL_STT_MODEL || "mistralai/Voxtral-Mini-4B-Realtime-2602");
}

function moshiSttProvider() {
  return httpSttProvider("moshi-http", process.env.MOSHI_STT_URL || "http://localhost:8788/transcribe", process.env.MOSHI_STT_MODEL || "kyutai/moshika-mlx-bf16");
}

function httpSttProvider(id, endpoint, model) {
  return {
    kind: "stt",
    id,
    endpoint,
    healthUrl: endpointSibling(endpoint, "/health"),
    model,
    async transcribe(fixture) {
      const url = new URL(endpoint);
      if (!url.searchParams.has("extension")) url.searchParams.set("extension", "wav");
      const started = performance.now();
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: readFileSync(fixture.path)
      }, timeoutMs);
      const elapsedMs = performance.now() - started;
      const body = await response.text();
      if (!response.ok) throw new Error(`${id} returned ${response.status}: ${body.slice(0, 1000)}`);
      const parsed = parseSttResponse(body);
      return {
        elapsedMs,
        reportedElapsedMs: parsed.elapsedMs ?? null,
        text: parsed.text,
        model: parsed.model || model
      };
    }
  };
}

async function checkHealth(provider) {
  if (!provider.healthUrl) return { checked: false, ok: null };
  try {
    const started = performance.now();
    const response = await fetchWithTimeout(provider.healthUrl, { method: "GET" }, Math.min(timeoutMs, 2_000));
    const elapsedMs = performance.now() - started;
    const text = await response.text();
    return {
      checked: true,
      ok: response.ok,
      status: response.status,
      elapsedMs: round(elapsedMs),
      body: safeJson(text) || text.slice(0, 500)
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      error: errorMessage(error)
    };
  }
}

async function benchmarkTtsProvider(provider, mode, language, text, repeat, health) {
  const request = provider.request(language, text, mode);
  const result = baseResult(provider, {
    mode,
    language,
    repeat,
    textChars: text.length,
    endpoint: provider.endpoint,
    health,
    model: provider.model,
    streaming: mode === "stream"
  });
  try {
    const audio = await postAudio(request, provider, result);
    const safeName = `${provider.id}-${mode}-${language}-r${repeat}.${audio.extension}`;
    const audioPath = join(audioRoot, safeName);
    if (audio.bytes > 0) writeFileSync(audioPath, audio.buffer);
    Object.assign(result, {
      ok: true,
      status: audio.status,
      contentType: audio.contentType,
      firstAudioLatencyMs: audio.firstAudioLatencyMs,
      totalSynthesisMs: audio.totalMs,
      outputAudioDurationSec: audio.durationSec,
      realTimeFactor: audio.durationSec ? round(audio.totalMs / 1000 / audio.durationSec) : null,
      bytesGenerated: audio.bytes,
      audioPath: audio.bytes > 0 ? relativeRepoPath(audioPath) : null,
      streamEnded: audio.streamEnded,
      streamIdleTimeoutMs: audio.streamEnded === false ? streamIdleMs : null,
      upstreamElapsedMs: audio.upstreamElapsedMs,
      providerMetadata: audio.providerMetadata
    });
  } catch (error) {
    Object.assign(result, {
      ok: false,
      error: errorMessage(error),
      failureCategory: classifyError(error)
    });
  }
  return result;
}

async function postAudio(request, provider, result) {
  const headers = { "Content-Type": "application/json", ...(request.headers || {}) };
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: controller.signal
    });
    const headersMs = performance.now() - started;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${provider.id} returned ${response.status}: ${body.slice(0, 1000)}`);
    }
    if (!response.body) throw new Error(`${provider.id} returned no response body`);

    const chunks = [];
    const reader = response.body.getReader();
    let firstAudioLatencyMs = null;
    let bytes = 0;
    let streamEnded = true;
    while (true) {
      const read = await readStreamChunk(reader, request.expectedFormat, bytes);
      if (read.idle) {
        streamEnded = false;
        await reader.cancel().catch(() => undefined);
        break;
      }
      const { done, value } = read;
      if (done) break;
      if (value?.byteLength) {
        if (firstAudioLatencyMs === null) firstAudioLatencyMs = performance.now() - started;
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        bytes += chunk.byteLength;
      }
    }
    const totalMs = performance.now() - started;
    const buffer = Buffer.concat(chunks);
    const contentType = response.headers.get("content-type") || contentTypeFromExpectedFormat(request.expectedFormat);
    const durationSec = audioDurationSec(buffer, contentType, request.expectedFormat, request.pcmSampleRate || provider.pcmSampleRate);
    return {
      status: response.status,
      contentType,
      firstAudioLatencyMs: firstAudioLatencyMs === null ? round(headersMs) : round(firstAudioLatencyMs),
      totalMs: round(totalMs),
      bytes,
      buffer,
      durationSec,
      streamEnded,
      extension: extensionForAudio(contentType, request.expectedFormat),
      upstreamElapsedMs: numberOrString(response.headers.get("x-tts-elapsed-ms")),
      providerMetadata: responseMetadata(response)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readStreamChunk(reader, expectedFormat, bytesRead) {
  if (!String(expectedFormat || "").startsWith("pcm") || bytesRead === 0 || streamIdleMs <= 0) {
    return reader.read();
  }
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ idle: true }), streamIdleMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function prepareSttFixtures(scenarios) {
  const fixtures = new Map();
  for (const scenario of scenarios) {
    const fixture = await prepareSttFixture(scenario);
    fixtures.set(scenario.id, fixture);
  }
  return fixtures;
}

async function prepareSttFixture(scenario) {
  if (!commandPath("say")) {
    return { ok: false, error: "macOS say command is unavailable" };
  }
  const aiffPath = join(fixtureRoot, `${scenario.id}.aiff`);
  const wavPath = join(fixtureRoot, `${scenario.id}.wav`);
  const say = spawnSync("say", ["-v", scenario.voice, "-o", aiffPath, scenario.text], { encoding: "utf8" });
  if (say.status !== 0) {
    return { ok: false, error: `say failed for ${scenario.voice}: ${(say.stderr || say.stdout || "").trim()}` };
  }
  const converter = commandPath("sox") ? "sox" : "ffmpeg";
  const conversion = converter === "sox"
    ? spawnSync("sox", [aiffPath, "-r", "16000", "-c", "1", wavPath], { encoding: "utf8" })
    : spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", aiffPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], { encoding: "utf8" });
  if (conversion.status !== 0) {
    return { ok: false, error: `${converter} failed: ${(conversion.stderr || conversion.stdout || "").trim()}` };
  }
  return {
    ok: true,
    path: wavPath,
    relativePath: relativeRepoPath(wavPath),
    durationSec: audioDurationSec(readFileSync(wavPath), "audio/wav", "wav"),
    expectedText: scenario.text
  };
}

async function benchmarkSttProvider(provider, scenario, fixture, repeat, health) {
  const result = baseResult(provider, {
    scenarioId: scenario.id,
    category: scenario.category,
    language: scenario.language,
    repeat,
    endpoint: provider.endpoint,
    health,
    model: provider.model,
    expectedText: scenario.text,
    fixturePath: fixture?.relativePath || null,
    fixtureDurationSec: fixture?.durationSec ?? null
  });
  if (!fixture?.ok) {
    return {
      ...result,
      ok: false,
      error: fixture?.error || "STT fixture unavailable",
      failureCategory: "fixture-unavailable"
    };
  }
  try {
    const transcript = await provider.transcribe(fixture, scenario);
    Object.assign(result, {
      ok: true,
      transcript: transcript.text,
      elapsedMs: round(transcript.elapsedMs),
      reportedElapsedMs: transcript.reportedElapsedMs,
      model: transcript.model || provider.model,
      transcriptChars: transcript.text.length,
      wordRecall: wordRecall(scenario.text, transcript.text)
    });
  } catch (error) {
    Object.assign(result, {
      ok: false,
      error: errorMessage(error),
      failureCategory: classifyError(error)
    });
  }
  return result;
}

async function transcribeWhisperServer(fixture) {
  const endpoint = whisperServerInferenceUrl(process.env.WHISPER_SERVER_URL);
  const started = performance.now();
  const form = new FormData();
  const audio = readFileSync(fixture.path);
  form.set("file", new Blob([audio], { type: "audio/wav" }), basename(fixture.path));
  form.set("response_format", "json");
  form.set("temperature", "0");
  form.set("language", process.env.WHISPER_LANGUAGE || "en");
  const response = await fetchWithTimeout(endpoint, { method: "POST", body: form }, timeoutMs);
  const elapsedMs = performance.now() - started;
  const body = await response.text();
  if (!response.ok) throw new Error(`whisper-server ${response.status}: ${body.slice(-1000)}`);
  return {
    elapsedMs,
    reportedElapsedMs: null,
    text: parseWhisperServerText(body),
    model: process.env.WHISPER_MODEL_PATH || "models/ggml-small.bin"
  };
}

async function transcribeWhisperCli(fixture) {
  const bin = process.env.WHISPER_CPP_BIN || "whisper-cli";
  const binPath = commandPath(bin);
  if (!binPath) throw new Error(`${bin} is not installed and WHISPER_SERVER_URL is not set`);
  const modelPath = resolveRepoPath(process.env.WHISPER_MODEL_PATH || "models/ggml-small.bin");
  if (!existsSync(modelPath)) throw new Error(`Whisper model not found: ${modelPath}`);
  const dir = mkdtempSync(join(tmpdir(), "meeting-whisper-bench-"));
  const out = join(dir, "transcript");
  try {
    const started = performance.now();
    const proc = spawnSync(bin, ["-m", modelPath, "-f", fixture.path, "-otxt", "-of", out, "-np"], { encoding: "utf8" });
    const elapsedMs = performance.now() - started;
    if (proc.status !== 0) throw new Error(`${bin} exited ${proc.status}: ${(proc.stderr || proc.stdout || "").slice(-2000)}`);
    return {
      elapsedMs,
      reportedElapsedMs: null,
      text: existsSync(`${out}.txt`) ? readFileSync(`${out}.txt`, "utf8").trim() : "",
      model: modelPath
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseResult(provider, fields) {
  return {
    provider: provider.id,
    kind: provider.kind,
    ...fields
  };
}

function summarizeRun(run) {
  return {
    tts: summarizeGroup(run.tts),
    stt: summarizeGroup(run.stt),
    ttsByProvider: summarizeByProvider(run.tts),
    sttByProvider: summarizeByProvider(run.stt)
  };
}

function summarizeGroup(items) {
  const ok = items.filter((item) => item.ok);
  return {
    total: items.length,
    ok: ok.length,
    failed: items.length - ok.length,
    failureRate: items.length ? round((items.length - ok.length) / items.length) : null
  };
}

function summarizeByProvider(items) {
  const providers = [...new Set(items.map((item) => item.provider))].sort();
  return Object.fromEntries(providers.map((provider) => {
    const group = items.filter((item) => item.provider === provider);
    const ok = group.filter((item) => item.ok);
    const failureRate = group.length ? round((group.length - ok.length) / group.length) : null;
    return [provider, {
      total: group.length,
      ok: ok.length,
      failed: group.length - ok.length,
      failureRate,
      avgFirstAudioLatencyMs: avg(ok.map((item) => item.firstAudioLatencyMs).filter(isNumber)),
      avgTotalSynthesisMs: avg(ok.map((item) => item.totalSynthesisMs).filter(isNumber)),
      avgRealTimeFactor: avg(ok.map((item) => item.realTimeFactor).filter(isNumber)),
      avgSttElapsedMs: avg(ok.map((item) => item.elapsedMs).filter(isNumber)),
      avgWordRecall: avg(ok.map((item) => item.wordRecall).filter(isNumber))
    }];
  }));
}

function renderMarkdown(run) {
  const lines = [];
  lines.push("# Speech Provider Benchmark");
  lines.push("");
  lines.push(`- Run ID: \`${run.runId}\``);
  lines.push(`- Started: ${run.startedAt}`);
  lines.push(`- Completed: ${run.completedAt}`);
  lines.push(`- Output root: \`${relativeRepoPath(run.outputRoot)}\``);
  lines.push(`- Timeout: ${run.timeoutMs} ms`);
  lines.push("");
  lines.push("## TTS Summary");
  lines.push("");
  lines.push("| Provider | Total | OK | Failed | Failure rate | Avg first audio ms | Avg total ms | Avg RTF |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [provider, summary] of Object.entries(run.summary.ttsByProvider)) {
    lines.push(`| ${provider} | ${summary.total} | ${summary.ok} | ${summary.failed} | ${formatValue(summary.failureRate)} | ${formatValue(summary.avgFirstAudioLatencyMs)} | ${formatValue(summary.avgTotalSynthesisMs)} | ${formatValue(summary.avgRealTimeFactor)} |`);
  }
  lines.push("");
  lines.push("## STT Summary");
  lines.push("");
  lines.push("| Provider | Total | OK | Failed | Failure rate | Avg elapsed ms | Avg word recall |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [provider, summary] of Object.entries(run.summary.sttByProvider)) {
    lines.push(`| ${provider} | ${summary.total} | ${summary.ok} | ${summary.failed} | ${formatValue(summary.failureRate)} | ${formatValue(summary.avgSttElapsedMs)} | ${formatValue(summary.avgWordRecall)} |`);
  }
  lines.push("");
  lines.push("## Failed Or Unavailable Providers");
  lines.push("");
  const failures = [...run.tts, ...run.stt].filter((item) => !item.ok);
  if (!failures.length) {
    lines.push("No failures recorded.");
  } else {
    for (const failure of failures.slice(0, 80)) {
      lines.push(`- ${failure.kind} ${failure.provider}${failure.language ? ` ${failure.language}` : ""}${failure.scenarioId ? ` ${failure.scenarioId}` : ""}: ${failure.failureCategory || "failed"} - ${failure.error}`);
    }
    if (failures.length > 80) lines.push(`- ${failures.length - 80} more failures omitted from this summary; see JSON output.`);
  }
  lines.push("");
  lines.push("## Raw Result Files");
  lines.push("");
  lines.push(`- JSON: \`${relativeRepoPath(join(run.outputRoot, "speech-provider-benchmark.json"))}\``);
  lines.push(`- Audio: \`${relativeRepoPath(audioRoot)}\``);
  lines.push(`- STT fixtures: \`${relativeRepoPath(fixtureRoot)}\``);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function printConsoleSummary(run) {
  console.log(`TTS: ${run.summary.tts.ok}/${run.summary.tts.total} ok, failureRate=${formatValue(run.summary.tts.failureRate)}`);
  console.log(`STT: ${run.summary.stt.ok}/${run.summary.stt.total} ok, failureRate=${formatValue(run.summary.stt.failureRate)}`);
}

function parseSttResponse(body) {
  try {
    const json = JSON.parse(body);
    const nested = json.result && typeof json.result === "object" ? json.result : {};
    const text = firstString(json.text, json.transcript, json.output, nested.text, nested.transcript);
    return {
      text: (text || "").trim(),
      model: firstString(json.model, nested.model),
      elapsedMs: firstNumber(json.elapsedMs, json.elapsed_ms, nested.elapsedMs, nested.elapsed_ms)
    };
  } catch {
    return { text: body.trim() };
  }
}

function parseWhisperServerText(body) {
  try {
    const payload = JSON.parse(body);
    if (typeof payload.text === "string") return payload.text.trim();
    if (Array.isArray(payload.segments)) return payload.segments.map((segment) => typeof segment.text === "string" ? segment.text : "").join(" ").trim();
  } catch {
    // Plain text responses are valid for some whisper.cpp builds.
  }
  return body.trim();
}

function audioDurationSec(buffer, contentType, expectedFormat, pcmSampleRate) {
  if (!buffer?.length) return null;
  const wav = parseWavDuration(buffer);
  if (wav !== null) return wav;
  if ((contentType || "").includes("audio/wav") || expectedFormat === "wav") return null;
  if (expectedFormat === "pcm_s16le" && pcmSampleRate) return round(buffer.length / (pcmSampleRate * 2));
  if (expectedFormat === "pcm_f32le" && pcmSampleRate) return round(buffer.length / (pcmSampleRate * 4));
  return null;
}

function parseWavDuration(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let channels = null;
  let sampleRate = null;
  let bitsPerSample = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (id === "fmt " && size >= 16 && dataOffset + size <= buffer.length) {
      channels = buffer.readUInt16LE(dataOffset + 2);
      sampleRate = buffer.readUInt32LE(dataOffset + 4);
      bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
    } else if (id === "data") {
      dataBytes = Math.min(size, buffer.length - dataOffset);
      break;
    }
    offset = dataOffset + size + (size % 2);
  }
  if (!channels || !sampleRate || !bitsPerSample || dataBytes === null) return null;
  return round(dataBytes / (sampleRate * channels * (bitsPerSample / 8)));
}

function wordRecall(expected, actual) {
  const expectedWords = normalizeWords(expected);
  const actualWords = new Set(normalizeWords(actual));
  if (!expectedWords.length) return null;
  const hits = expectedWords.filter((word) => actualWords.has(word)).length;
  return round(hits / expectedWords.length);
}

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function commandPath(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function endpointSibling(endpoint, pathname) {
  try {
    const url = new URL(endpoint);
    url.pathname = pathname;
    url.search = "";
    return String(url);
  } catch {
    return null;
  }
}

function whisperServerInferenceUrl(serverUrl) {
  const normalized = serverUrl.replace(/\/+$/, "");
  return normalized.endsWith("/inference") ? normalized : `${normalized}/inference`;
}

function extensionForAudio(contentType, expectedFormat) {
  if ((contentType || "").includes("mpeg")) return "mp3";
  if ((contentType || "").includes("flac")) return "flac";
  if ((contentType || "").includes("ogg")) return "ogg";
  if (expectedFormat?.startsWith("pcm")) return "pcm";
  return "wav";
}

function contentTypeFromExpectedFormat(format) {
  if (format === "mp3") return "audio/mpeg";
  if (format === "flac") return "audio/flac";
  if (format === "opus") return "audio/ogg";
  if (format?.startsWith("pcm")) return "application/octet-stream";
  return "audio/wav";
}

function responseMetadata(response) {
  const metadata = {};
  for (const [key, value] of response.headers.entries()) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("x-tts-") || normalized.startsWith("x-qwen3-tts-")) metadata[key] = value;
  }
  return metadata;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function classifyError(error) {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("fetch failed") || message.includes("econnrefused") || message.includes("could not connect")) return "unavailable";
  if (message.includes("abort") || message.includes("timeout")) return "timeout";
  if (message.includes("not installed") || message.includes("not found")) return "missing-dependency";
  if (message.includes("returned 4") || message.includes("returned 5")) return "provider-error";
  return "failed";
}

function firstString(...values) {
  return values.find((value) => typeof value === "string");
}

function firstNumber(...values) {
  return values.find((value) => typeof value === "number" && Number.isFinite(value));
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function avg(values) {
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function numberOrString(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function isLocalEndpoint(endpoint) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(endpoint);
}

function relativeRepoPath(path) {
  const resolved = resolve(path);
  return resolved.startsWith(`${repoRoot}/`) ? resolved.slice(repoRoot.length + 1) : resolved;
}

function formatValue(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}
