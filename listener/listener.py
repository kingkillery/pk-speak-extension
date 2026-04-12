"""
Two-tier voice listener for pi-speak-extension.

Tier 1: Vosk (always-on, low CPU) listens for wake phrases "pi mono on" / "pi mono off".
Tier 2: faster-whisper (activated on demand) transcribes full speech for Pi messages.

Outputs JSON lines to stdout for the Node.js extension to consume.
"""

import sys
import json
import queue
import threading
import os
import re
import tempfile
import time
from pathlib import Path

import numpy as np
import sounddevice as sd

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
SAMPLE_RATE = 16000
VOSK_BLOCK_SIZE = 4000  # ~250ms chunks for Vosk
WHISPER_MODEL = "tiny"
WAKE_ON = "pi mono on"
WAKE_OFF = "pi mono off"
SILENCE_TIMEOUT = 2.0  # seconds of silence before finalizing a whisper segment
ENERGY_THRESHOLD = 300  # RMS threshold for voice activity

audio_queue: queue.Queue = queue.Queue()
active = False  # whether voice mode is on
running = True


def emit(event_type: str, **kwargs):
    """Send a JSON event to stdout."""
    payload = {"type": event_type, **kwargs}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def rms(data: np.ndarray) -> float:
    """Root mean square energy of audio chunk."""
    return float(np.sqrt(np.mean(data.astype(np.float32) ** 2)))


# ---------------------------------------------------------------------------
# Audio capture callback
# ---------------------------------------------------------------------------
def audio_callback(indata, frames, time_info, status):
    if status:
        emit("error", message=str(status))
    audio_queue.put(bytes(indata))


# ---------------------------------------------------------------------------
# Vosk wake-word detector (Tier 1)
# ---------------------------------------------------------------------------
def run_vosk_detector(on_wake_on, on_wake_off, on_speech_while_active):
    """Continuously process audio with Vosk. Detect wake phrases and forward
    partial text when voice mode is active."""
    from vosk import Model as VoskModel, KaldiRecognizer

    model_path = os.environ.get("VOSK_MODEL_PATH", "")
    if model_path and os.path.isdir(model_path):
        model = VoskModel(model_path)
    else:
        # Vosk auto-downloads a small English model if none is specified
        model = VoskModel(lang="en-us")

    recognizer = KaldiRecognizer(model, SAMPLE_RATE)
    recognizer.SetWords(True)

    collecting_for_whisper = False
    whisper_buffer = bytearray()
    last_voice_time = time.time()

    while running:
        try:
            data = audio_queue.get(timeout=0.5)
        except queue.Empty:
            # Check silence timeout when collecting for whisper
            if collecting_for_whisper and (time.time() - last_voice_time) > SILENCE_TIMEOUT:
                if len(whisper_buffer) > SAMPLE_RATE * 2:  # at least 1 second
                    on_speech_while_active(bytes(whisper_buffer))
                whisper_buffer.clear()
                collecting_for_whisper = False
            continue

        # Feed to Vosk for wake detection
        if recognizer.AcceptWaveform(data):
            result = json.loads(recognizer.Result())
            text = result.get("text", "").lower().strip()

            if not text:
                continue

            # Check wake phrases (always, regardless of active state)
            if WAKE_ON in text:
                on_wake_on()
                collecting_for_whisper = False
                whisper_buffer.clear()
                continue

            if WAKE_OFF in text:
                on_wake_off()
                collecting_for_whisper = False
                whisper_buffer.clear()
                continue

            # If active, collect audio for whisper transcription
            if active:
                collecting_for_whisper = True
                whisper_buffer.extend(data)
                last_voice_time = time.time()
        else:
            # Partial result -- keep collecting if active
            if active:
                energy = rms(np.frombuffer(data, dtype=np.int16))
                if energy > ENERGY_THRESHOLD:
                    collecting_for_whisper = True
                    last_voice_time = time.time()
                if collecting_for_whisper:
                    whisper_buffer.extend(data)

                # Check silence timeout
                if collecting_for_whisper and (time.time() - last_voice_time) > SILENCE_TIMEOUT:
                    if len(whisper_buffer) > SAMPLE_RATE * 2:
                        on_speech_while_active(bytes(whisper_buffer))
                    whisper_buffer.clear()
                    collecting_for_whisper = False


# ---------------------------------------------------------------------------
# faster-whisper transcriber (Tier 2)
# ---------------------------------------------------------------------------
_whisper_model = None
_whisper_lock = threading.Lock()


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel
                device = os.environ.get("WHISPER_DEVICE", "cpu")
                compute = os.environ.get("WHISPER_COMPUTE", "int8")
                model_size = os.environ.get("WHISPER_MODEL", WHISPER_MODEL)
                emit("status", message=f"Loading whisper model ({model_size}, {device}, {compute})...")
                _whisper_model = WhisperModel(model_size, device=device, compute_type=compute)
                emit("status", message="Whisper model loaded")
    return _whisper_model


def transcribe_audio(audio_bytes: bytes) -> str:
    """Transcribe raw 16-bit 16kHz mono PCM audio using faster-whisper."""
    model = get_whisper_model()
    audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    segments, _info = model.transcribe(audio_np, beam_size=3, language="en",
                                        vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500))
    parts = [seg.text.strip() for seg in segments if seg.text.strip()]
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global active, running

    emit("status", message="Voice listener starting...")

    def on_wake_on():
        global active
        if not active:
            active = True
            emit("wake", state="on")
            # Pre-load whisper model in background
            threading.Thread(target=get_whisper_model, daemon=True).start()

    def on_wake_off():
        global active
        if active:
            active = False
            emit("wake", state="off")

    def on_speech(audio_bytes: bytes):
        if not active:
            return
        emit("transcribing")
        try:
            text = transcribe_audio(audio_bytes)
            if text:
                emit("speech", text=text)
        except Exception as e:
            emit("error", message=f"Transcription failed: {e}")

    # Start audio stream
    try:
        stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            blocksize=VOSK_BLOCK_SIZE,
            dtype="int16",
            channels=1,
            callback=audio_callback,
        )
        stream.start()
        emit("status", message="Listening (waiting for wake phrase)")
    except Exception as e:
        emit("error", message=f"Failed to open audio stream: {e}")
        sys.exit(1)

    try:
        run_vosk_detector(on_wake_on, on_wake_off, on_speech)
    except KeyboardInterrupt:
        pass
    finally:
        running = False
        stream.stop()
        stream.close()
        emit("status", message="Listener stopped")


if __name__ == "__main__":
    main()
