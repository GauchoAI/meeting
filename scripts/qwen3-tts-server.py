#!/usr/bin/env python3
from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import Queue
from typing import Any

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("QWEN3_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN3_TTS_PORT", "8794"))
MODEL_ID = os.environ.get("QWEN3_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base")
DEVICE = os.environ.get("QWEN3_TTS_DEVICE", "auto")
DTYPE = os.environ.get("QWEN3_TTS_DTYPE", "auto")
WORKERS = max(1, int(os.environ.get("QWEN3_TTS_WORKERS", "2")))
REF_DIR = Path(os.environ.get("QWEN3_TTS_REF_DIR", str(ROOT / ".meeting" / "qwen3-tts-refs")))


REFERENCE_VOICES = {
    "english": {
        "voice": os.environ.get("QWEN3_TTS_ENGLISH_REF_VOICE", "Samantha"),
        "text": os.environ.get("QWEN3_TTS_ENGLISH_REF_TEXT", "Hello, this is a short reference voice for testing the meeting assistant."),
    },
    "spanish": {
        "voice": os.environ.get("QWEN3_TTS_SPANISH_REF_VOICE", "Mónica"),
        "text": os.environ.get("QWEN3_TTS_SPANISH_REF_TEXT", "Hola, esta es una breve voz de referencia para probar el asistente de reuniones."),
    },
    "russian": {
        "voice": os.environ.get("QWEN3_TTS_RUSSIAN_REF_VOICE", "Milena"),
        "text": os.environ.get("QWEN3_TTS_RUSSIAN_REF_TEXT", "Здравствуйте. Это короткий образец голоса для проверки помощника встречи."),
    },
}


def choose_device() -> str:
    if DEVICE != "auto":
        return DEVICE
    return "mps" if torch.backends.mps.is_available() else "cpu"


def choose_dtype(device: str) -> torch.dtype:
    if DTYPE == "float16":
        return torch.float16
    if DTYPE == "bfloat16":
        return torch.bfloat16
    if DTYPE == "float32":
        return torch.float32
    # float16 loaded on MPS but produced NaNs in Qwen generation on this machine.
    return torch.float32 if device == "mps" else torch.float32


def run_checked(args: list[str]) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def reference_path(language: str) -> Path:
    return REF_DIR / f"ref-{language}.wav"


def prepare_reference_audio(language: str) -> Path:
    language = normalize_language(language)
    configured = os.environ.get(f"QWEN3_TTS_{language.upper()}_REF_AUDIO")
    if configured:
        path = Path(configured).expanduser()
        if path.exists():
            return path

    REF_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = reference_path(language)
    if wav_path.exists():
        return wav_path

    ref = REFERENCE_VOICES[language]
    aiff_path = REF_DIR / f"ref-{language}.aiff"
    if sys.platform != "darwin" or not shutil.which("say"):
        raise RuntimeError(f"Missing QWEN3_TTS_{language.upper()}_REF_AUDIO. Automatic reference generation requires macOS 'say'.")
    run_checked(["say", "-v", ref["voice"], "-o", str(aiff_path), ref["text"]])
    if shutil.which("sox"):
        run_checked(["sox", str(aiff_path), "-r", "24000", "-c", "1", str(wav_path)])
        return wav_path
    return aiff_path


def normalize_language(value: str | None) -> str:
    if not value or value == "auto":
        return "auto"
    normalized = value.strip().lower()
    if normalized in {"en", "eng", "english"}:
        return "english"
    if normalized in {"es", "spa", "spanish", "español"}:
        return "spanish"
    if normalized in {"ru", "rus", "russian"}:
        return "russian"
    return normalized


def detect_language(text: str) -> str:
    lower = f" {text.lower()} "
    if re.search(r"[а-яё]", lower):
        return "russian"
    if re.search(r"[¿¡ñáéíóúü]", lower):
        return "spanish"
    spanish_hits = [
        " el ", " la ", " los ", " las ", " una ", " unas ", " de ", " del ",
        " que ", " para ", " pero ", " porque ", " como ", " con ", " sin ",
        " esto ", " esta ", " este ", " proyecto ", " agente ", " reunión ",
    ]
    if sum(token in lower for token in spanish_hits) >= 3:
        return "spanish"
    return "english"


def request_text(payload: dict[str, Any]) -> str:
    text = payload.get("text") or payload.get("input")
    if isinstance(text, list):
        text = " ".join(str(item) for item in text)
    return str(text or "").strip()


class Qwen3TtsEngine:
    def __init__(self, index: int) -> None:
        self.index = index
        self.lock = threading.Lock()
        self.device = choose_device()
        self.dtype = choose_dtype(self.device)
        started = time.time()
        print(f"[meeting-qwen3-tts] loading worker={self.index} {MODEL_ID} on {self.device} dtype={self.dtype}", flush=True)
        self.model = Qwen3TTSModel.from_pretrained(
            MODEL_ID,
            device_map=self.device,
            dtype=self.dtype,
            attn_implementation=None,
        )
        self.supported_languages = set(self.model.get_supported_languages() or [])
        print(f"[meeting-qwen3-tts] worker={self.index} ready in {time.time() - started:.2f}s; languages={sorted(self.supported_languages)}", flush=True)

    def synthesize(self, text: str, requested_language: str | None) -> tuple[bytes, int, str, float]:
        language = normalize_language(requested_language)
        if language == "auto":
            language = detect_language(text)
        if language not in REFERENCE_VOICES:
            language = "english"
        if self.supported_languages and language not in self.supported_languages:
            raise RuntimeError(f"Qwen3 TTS model does not report support for language={language!r}")

        ref_audio = prepare_reference_audio(language)
        ref_text = REFERENCE_VOICES[language]["text"]
        started = time.time()
        with self.lock:
            wavs, sample_rate = self.model.generate_voice_clone(
                text=text,
                language=language,
                ref_audio=str(ref_audio),
                ref_text=ref_text,
                x_vector_only_mode=False,
                non_streaming_mode=True,
                max_new_tokens=int(os.environ.get("QWEN3_TTS_MAX_NEW_TOKENS", "900")),
                temperature=float(os.environ.get("QWEN3_TTS_TEMPERATURE", "0.6")),
                top_p=float(os.environ.get("QWEN3_TTS_TOP_P", "0.9")),
            )
        elapsed_ms = (time.time() - started) * 1000
        with io.BytesIO() as buffer:
            sf.write(buffer, wavs[0], sample_rate, format="WAV")
            return buffer.getvalue(), sample_rate, language, elapsed_ms


class Qwen3TtsPool:
    def __init__(self, workers: int) -> None:
        self.engines = [Qwen3TtsEngine(index + 1) for index in range(workers)]
        self.available: Queue[Qwen3TtsEngine] = Queue()
        for engine in self.engines:
            self.available.put(engine)
        self.device = self.engines[0].device
        self.dtype = self.engines[0].dtype
        self.supported_languages = set().union(*(engine.supported_languages for engine in self.engines))

    def synthesize(self, text: str, requested_language: str | None) -> tuple[bytes, int, str, float, int]:
        engine = self.available.get()
        try:
            audio, sample_rate, language, elapsed_ms = engine.synthesize(text, requested_language)
            return audio, sample_rate, language, elapsed_ms, engine.index
        finally:
            self.available.put(engine)


ENGINE_POOL = Qwen3TtsPool(WORKERS)


class Handler(BaseHTTPRequestHandler):
    server_version = "meeting-qwen3-tts/0.1"

    def do_GET(self) -> None:
        if self.path.rstrip("/") in {"", "/health"}:
            self.write_json(200, {
                "ok": True,
                "provider": "qwen3-tts",
                "model": MODEL_ID,
                "device": ENGINE_POOL.device,
                "dtype": str(ENGINE_POOL.dtype),
                "workers": len(ENGINE_POOL.engines),
                "languages": sorted(ENGINE_POOL.supported_languages),
            })
            return
        self.write_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path not in {"/synthesize", "/v1/audio/speech"}:
            self.write_json(404, {"error": "not found"})
            return
        try:
            raw = self.rfile.read(int(self.headers.get("content-length", "0")))
            payload = json.loads(raw.decode("utf-8") or "{}")
            text = request_text(payload)
            if not text:
                self.write_json(400, {"error": "text is required"})
                return
            audio, sample_rate, language, elapsed_ms, worker = ENGINE_POOL.synthesize(text, payload.get("language"))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-TTS-Elapsed-Ms", str(int(elapsed_ms)))
            self.send_header("X-Qwen3-TTS-Language", language)
            self.send_header("X-Qwen3-TTS-Sample-Rate", str(sample_rate))
            self.send_header("X-Qwen3-TTS-Model", MODEL_ID)
            self.send_header("X-Qwen3-TTS-Worker", str(worker))
            self.end_headers()
            self.wfile.write(audio)
            print(f"[meeting-qwen3-tts] {int(elapsed_ms)}ms worker={worker} language={language} chars={len(text)} bytes={len(audio)}", flush=True)
        except Exception as exc:
            print(f"[meeting-qwen3-tts] error: {exc}", flush=True)
            self.write_json(500, {"error": str(exc)})

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[meeting-qwen3-tts] http://{HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
