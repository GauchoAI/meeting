#!/usr/bin/env python3
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import perth
import torch
import torchaudio as ta


class NoopWatermarker:
    def apply_watermark(self, wav, sample_rate):
        return wav


if getattr(perth, "PerthImplicitWatermarker", None) is None:
    perth.PerthImplicitWatermarker = NoopWatermarker

from chatterbox.tts_turbo import ChatterboxTurboTTS


HOST = os.environ.get("CHATTERBOX_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHATTERBOX_TTS_PORT", "8791"))
DEVICE = os.environ.get("CHATTERBOX_TTS_DEVICE") or ("mps" if torch.backends.mps.is_available() else "cpu")
MAX_CHARS = int(os.environ.get("CHATTERBOX_TTS_MAX_CHARS", "700"))

model_lock = threading.Lock()
print(f"[meeting-tts] loading Chatterbox Turbo on {DEVICE}", flush=True)
load_started = time.time()
model = ChatterboxTurboTTS.from_pretrained(device=DEVICE)
print(f"[meeting-tts] ready in {time.time() - load_started:.2f}s, sr={model.sr}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "MeetingChatterboxTTS/0.1"

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"ok": True, "provider": "chatterbox-turbo", "device": DEVICE, "sampleRate": model.sr})
            return
        self._send_json({"ok": False, "error": "not found"}, status=404)

    def do_POST(self):
        if self.path != "/synthesize":
            self._send_json({"ok": False, "error": "not found"}, status=404)
            return
        try:
            length = int(self.headers.get("Content-Length") or "0")
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            text = " ".join(str(payload.get("text") or "").split())[:MAX_CHARS]
            if not text:
                self._send_json({"ok": False, "error": "missing text"}, status=400)
                return
            started = time.time()
            with model_lock:
                wav = model.generate(
                    text,
                    temperature=float(payload.get("temperature") or 0.8),
                    repetition_penalty=float(payload.get("repetitionPenalty") or 1.2),
                )
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp_path = Path(tmp.name)
            try:
                ta.save(str(tmp_path), wav, model.sr)
                audio = tmp_path.read_bytes()
            finally:
                tmp_path.unlink(missing_ok=True)
            elapsed_ms = int((time.time() - started) * 1000)
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-TTS-Provider", "chatterbox-turbo")
            self.send_header("X-TTS-Elapsed-Ms", str(elapsed_ms))
            self.end_headers()
            self.wfile.write(audio)
            print(f"[meeting-tts] {elapsed_ms}ms chars={len(text)} bytes={len(audio)}", flush=True)
        except Exception as error:
            self._send_json({"ok": False, "error": str(error)}, status=500)

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    print(f"[meeting-tts] http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
