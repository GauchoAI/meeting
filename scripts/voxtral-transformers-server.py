#!/usr/bin/env python3
"""Tiny local Voxtral STT bridge for the Meeting API.

This keeps the model loaded once and exposes:

  POST /transcribe?extension=webm

The response shape matches apps/api/src/local-stt.ts:

  {"text": "...", "model": "...", "elapsedMs": 1234}

It is an experimental bridge for evaluating Voxtral as a drop-in replacement
for the local Whisper chunk endpoint. For true low-latency streaming, prefer a
vLLM realtime deployment once the basic quality test passes.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


MODEL_ID = os.environ.get("VOXTRAL_STT_MODEL", "mistralai/Voxtral-Mini-4B-Realtime-2602")
HOST = os.environ.get("VOXTRAL_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("VOXTRAL_STT_PORT", "8787"))


def load_model():
    from mistral_common.tokens.tokenizers.audio import Audio
    from transformers import AutoProcessor, VoxtralRealtimeForConditionalGeneration

    processor = AutoProcessor.from_pretrained(MODEL_ID)
    model = VoxtralRealtimeForConditionalGeneration.from_pretrained(MODEL_ID, device_map="auto")
    return Audio, processor, model


Audio, PROCESSOR, MODEL = load_model()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802
        if urlparse(self.path).path == "/health":
            self.send_json({"ok": True, "model": MODEL_ID})
            return
        self.send_json({"error": "not found"}, status=404)

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            self.send_json({"error": "not found"}, status=404)
            return
        length = int(self.headers.get("content-length") or "0")
        audio = self.rfile.read(length)
        extension = parse_qs(parsed.query).get("extension", ["webm"])[0] or "webm"
        started = time.time()
        try:
            text = transcribe(audio, extension)
            self.send_json({
                "text": text,
                "model": MODEL_ID,
                "elapsedMs": int((time.time() - started) * 1000),
            })
        except Exception as exc:  # noqa: BLE001
            self.send_json({"error": str(exc)}, status=500)

    def log_message(self, fmt, *args):  # noqa: A003
        print(f"[voxtral-stt] {self.address_string()} {fmt % args}")

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def transcribe(audio_bytes: bytes, extension: str) -> str:
    suffix = f".{safe_extension(extension)}"
    with tempfile.TemporaryDirectory(prefix="meeting-voxtral-") as tmpdir:
        source = Path(tmpdir) / f"chunk{suffix}"
        source.write_bytes(audio_bytes)
        audio = Audio.from_file(str(source), strict=False)
        audio.resample(PROCESSOR.feature_extractor.sampling_rate)
        inputs = PROCESSOR(audio.audio_array, return_tensors="pt")
        inputs = inputs.to(MODEL.device, dtype=MODEL.dtype)
        outputs = MODEL.generate(**inputs)
        decoded = PROCESSOR.batch_decode(outputs, skip_special_tokens=True)
        return (decoded[0] if decoded else "").strip()


def safe_extension(extension: str) -> str:
    cleaned = "".join(ch for ch in extension.lower() if ch.isalnum())
    return cleaned[:12] or "webm"


if __name__ == "__main__":
    print(f"[voxtral-stt] loading complete: {MODEL_ID}")
    print(f"[voxtral-stt] listening on http://{HOST}:{PORT}/transcribe")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
