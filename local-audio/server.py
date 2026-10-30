"""Loopback-only trained audio listener. No catalog, fingerprinting, or inference API."""
import argparse
import base64
import binascii
import io
import json
import math
import os
import sys
import time
from importlib.metadata import version
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
import wave

MODEL_ID = "Qwen/Qwen2-Audio-7B-Instruct"
PROMPT = (
    "Listen to this music clip using your learned knowledge only. Describe audible "
    "instruments, production style and likely era or release-year range. Give a "
    "possible artist/title only if you recognize it. Clearly distinguish guesses "
    "from recognition and state uncertainty. No web searches, catalogs or "
    "fingerprinting. Return a concise assessment, not lyrics."
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    cache = Path(__file__).resolve().parents[1] / "data" / "local-audio-models"
    os.environ.setdefault("HF_HOME", str(cache))

    print(f"Python {sys.version.split()[0]}; executable: {sys.executable}", flush=True)
    print("Runtime versions: " + ", ".join(f"{name}={version(name)}" for name in
          ("torch", "transformers", "accelerate", "bitsandbytes")), flush=True)
    print("Importing audio and CUDA libraries...", flush=True)

    import numpy as np
    from scipy.signal import resample_poly
    import torch
    from transformers import AutoProcessor, BitsAndBytesConfig, Qwen2AudioForConditionalGeneration

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA-enabled PyTorch and an NVIDIA GPU are required for this 4-bit listener. See README.md.")
    print(f"Loading {MODEL_ID} in 4-bit on {torch.cuda.get_device_name(0)}. First start downloads model weights.", flush=True)
    free, total = torch.cuda.mem_get_info(0)
    print(f"CUDA {torch.version.cuda}; GPU memory: {free // (1024 ** 2)} MiB free / {total // (1024 ** 2)} MiB total.", flush=True)
    print("Loading audio processor...", flush=True)
    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=False)
    print("Loading model weights and initializing 4-bit CUDA quantization...", flush=True)
    model = Qwen2AudioForConditionalGeneration.from_pretrained(
        MODEL_ID, trust_remote_code=False, device_map={"": 0}, dtype=torch.float16,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.float16,
        ),
        attn_implementation="sdpa",
    ).eval()
    print("Model weights loaded successfully.", flush=True)
    if args.download_only:
        print("Model downloaded and loaded successfully.", flush=True)
        return

    def infer(encoded):
        started = time.monotonic()
        print("Audio request received; decoding WAV...", flush=True)
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError, binascii.Error) as error:
            raise ValueError("Expected a base64 PCM WAV.") from error
        try:
            with wave.open(io.BytesIO(raw), "rb") as wav:
                rate = wav.getframerate()
                if (wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getcomptype() != "NONE"
                        or not 8000 <= rate <= 192000 or not 1 <= wav.getnframes() <= rate * 12):
                    raise ValueError("Expected mono PCM16 WAV, at most 12 seconds.")
                frames = wav.readframes(wav.getnframes())
        except (wave.Error, EOFError) as error:
            raise ValueError("Invalid PCM WAV.") from error
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
        if not audio.size or float(np.sqrt(np.mean(audio * audio))) < 0.00001:
            raise ValueError("Audio is empty or silent.")
        target_rate = processor.feature_extractor.sampling_rate
        if rate != target_rate:
            divisor = math.gcd(rate, target_rate)
            audio = resample_poly(audio, target_rate // divisor, rate // divisor).astype(np.float32)
        print(f"Audio ready: {audio.size / target_rate:.1f}s at {target_rate} Hz; preparing model input...", flush=True)
        # The neutral placeholder is a chat-template marker, never fetched or interpreted as a URL.
        conversation = [{"role": "user", "content": [
            {"type": "audio", "audio_url": "clip.wav"}, {"type": "text", "text": PROMPT},
        ]}]
        text = processor.apply_chat_template(conversation, add_generation_prompt=True, tokenize=False)
        inputs = processor(text=text, audios=[audio], sampling_rate=target_rate,
                           return_tensors="pt", padding=True).to("cuda:0")
        if "input_features" in inputs:
            inputs["input_features"] = inputs["input_features"].to(torch.float16)
        print("Running local audio inference (256 new token limit, 90s generation limit)...", flush=True)
        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=256, max_time=90, do_sample=False)
        generated = output[:, inputs.input_ids.size(1):]
        assessment = processor.batch_decode(generated, skip_special_tokens=True,
                                            clean_up_tokenization_spaces=False)[0].strip()
        if not assessment:
            raise RuntimeError("Model returned no assessment.")
        print(f"Audio inference completed in {time.monotonic() - started:.1f}s; generated {generated.size(1)} tokens.", flush=True)
        return {"model": MODEL_ID, "text": assessment[:4000], "usage": {
            "input_tokens": int(inputs.input_ids.size(1)), "output_tokens": int(generated.size(1)),
        }}

    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, payload):
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"status": "ready", "model": MODEL_ID})
            else:
                self.reply(404, {"error": "Not found"})

        def do_POST(self):
            if self.path != "/listen":
                self.reply(404, {"error": "Not found"})
                return
            try:
                self.connection.settimeout(30)
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8 * 1024 * 1024:
                    raise ValueError("Invalid request size.")
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict) or not isinstance(data.get("audio"), str):
                    raise ValueError("Expected an audio field.")
                result = infer(data["audio"])
            except (ValueError, TypeError) as error:
                self.reply(400, {"error": str(error)})
                return
            except Exception as error:
                # Do not print submitted audio or model prompts.
                print(f"Local inference failed: {type(error).__name__}: {error}", flush=True)
                self.reply(500, {"error": "Local inference failed; check the listener terminal."})
                return
            self.reply(200, result)

        def log_message(self, *_args):
            pass

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Local listener ready at http://127.0.0.1:{args.port}; inference stays on this machine.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
