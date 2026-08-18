"""
Minimal HTTP server wrapping MusicGen for text-to-music generation
(spec §3: "plain Python process running MusicGen... no ComfyUI needed for
audio-only tasks"). Uses only the standard library for the server itself
(no Flask) to keep the venv's dependency footprint small.

Usage: python musicgen_server.py <model_dir> <port>
  model_dir - a local directory transformers can load via from_pretrained
              (weights file + config/tokenizer files), prepared by
              prepareModelDir.ts.
"""

import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import torch
from transformers import AutoProcessor, MusicgenForConditionalGeneration

MODEL_DIR = sys.argv[1]
PORT = int(sys.argv[2])

device = "cuda" if torch.cuda.is_available() else "cpu"
processor = AutoProcessor.from_pretrained(MODEL_DIR)
model = MusicgenForConditionalGeneration.from_pretrained(MODEL_DIR).to(device)
model.eval()
sampling_rate = model.config.audio_encoder.sampling_rate

# MusicGen's audio codec runs at 50 frames/sec regardless of model size.
TOKENS_PER_SECOND = 50


def write_wav(path: str, rate: int, audio: np.ndarray) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clipped = np.clip(audio, -1.0, 1.0)
    pcm16 = (clipped * 32767).astype(np.int16)
    with wave.open(path, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(pcm16.tobytes())


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
            prompt = body["prompt"]
            output_path = body["output_path"]
            duration_seconds = float(body.get("duration_seconds", 8))
            max_new_tokens = max(1, int(duration_seconds * TOKENS_PER_SECOND))

            inputs = processor(text=[prompt], padding=True, return_tensors="pt").to(device)
            with torch.no_grad():
                audio_values = model.generate(**inputs, max_new_tokens=max_new_tokens)
            audio = audio_values[0, 0].to("cpu").float().numpy()

            write_wav(output_path, sampling_rate, audio)
            self._send_json(200, {"status": "success"})
        except Exception as exc:  # noqa: BLE001 - report to caller, don't crash the server
            self._send_json(500, {"status": "error", "error": str(exc)})

    def log_message(self, format, *args):  # noqa: A002 - silence default request logging
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
