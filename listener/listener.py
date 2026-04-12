"""
Two-tier voice listener for pi-speak-extension.

Tier 1: Vosk (always-on, low CPU) listens for wake phrase "pi mono".
        Saying "pi mono" activates voice input. It stays active as long as
        "pi mono" is heard again within ACTIVITY_TIMEOUT seconds (keep-alive).
        Auto-deactivates after the timeout expires.
Tier 2: faster-whisper (activated on demand) transcribes full speech for Pi messages.

Outputs JSON lines to stdout for the Node.js extension to consume.
"""

import sys
import json
import queue
import threading
import os
import re
import time
import collections

import numpy as np
import sounddevice as sd

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
SAMPLE_RATE = 16000
VOSK_BLOCK_SIZE = 4000  # ~250ms chunks for Vosk
WHISPER_MODEL = "tiny"
WAKE_RE = re.compile(r'\bpi\s+mono(?:\s+(\S+))?', re.IGNORECASE)
SILENCE_TIMEOUT = 2.0  # seconds of silence before finalizing a whisper segment
ACTIVITY_TIMEOUT = 10.0  # seconds without "pi mono" before auto-deactivating
ENERGY_THRESHOLD = 300  # RMS threshold for voice activity
PRE_BUFFER_CHUNKS = 4  # ~1 second of lookback to capture utterance onset

audio_queue: queue.Queue = queue.Queue()
transcription_queue: queue.Queue = queue.Queue(maxsize=3)  # bounded: drop oldest if full
active = False  # whether voice mode is on
last_wake_time = 0.0  # wall-clock of last "pi mono" utterance
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
def whisper_worker():
    """Background thread that pulls audio from transcription_queue and transcribes."""
    while running:
        try:
            audio_bytes = transcription_queue.get(timeout=1.0)
        except queue.Empty:
            continue
        if audio_bytes is None:  # poison pill
            break
        emit("transcribing")
        try:
            text = transcribe_audio(audio_bytes)
            if text:
                emit("speech", text=text)
        except Exception as e:
            emit("error", message=f"Transcription failed: {e}")


def run_vosk_detector(on_wake, on_timeout):
    """Continuously process audio with Vosk. Detect "pi mono" wake phrase and
    enqueue audio for whisper transcription while active. Auto-deactivates
    after ACTIVITY_TIMEOUT seconds without hearing "pi mono" again."""
    global last_wake_time

    from vosk import Model as VoskModel, KaldiRecognizer

    model_path = os.environ.get("VOSK_MODEL_PATH", "")
    if model_path and os.path.isdir(model_path):
        model = VoskModel(model_path)
    else:
        model = VoskModel(lang="en-us")

    recognizer = KaldiRecognizer(model, SAMPLE_RATE)
    recognizer.SetWords(True)

    collecting_for_whisper = False
    whisper_buffer = bytearray()
    last_voice_time = time.time()
    pre_buffer: collections.deque = collections.deque(maxlen=PRE_BUFFER_CHUNKS)

    def flush_to_whisper():
        nonlocal collecting_for_whisper
        if len(whisper_buffer) > SAMPLE_RATE * 2:
            audio_bytes = bytes(whisper_buffer)
            if transcription_queue.full():
                try:
                    transcription_queue.get_nowait()
                except queue.Empty:
                    pass
            transcription_queue.put(audio_bytes)
        whisper_buffer.clear()
        collecting_for_whisper = False

    def check_activity_timeout():
        """Auto-deactivate if "pi mono" hasn't been heard within ACTIVITY_TIMEOUT."""
        if active and last_wake_time > 0 and (time.time() - last_wake_time) > ACTIVITY_TIMEOUT:
            on_timeout()
            # Flush any pending audio before deactivating
            nonlocal collecting_for_whisper
            if collecting_for_whisper:
                flush_to_whisper()

    while running:
        try:
            data = audio_queue.get(timeout=0.5)
        except queue.Empty:
            check_activity_timeout()
            if collecting_for_whisper and (time.time() - last_voice_time) > SILENCE_TIMEOUT:
                flush_to_whisper()
            continue

        # Check activity timeout on every chunk
        check_activity_timeout()

        pre_buffer.append(data)

        if recognizer.AcceptWaveform(data):
            result = json.loads(recognizer.Result())
            text = result.get("text", "").lower().strip()

            if not text:
                continue

            # "pi mono [target]" acts as activate + keep-alive + target selection
            match = WAKE_RE.search(text)
            if match:
                last_wake_time = time.time()
                target_name = match.group(1) or None
                on_wake(target_name)
                # Don't capture the wake phrase itself as speech
                collecting_for_whisper = False
                whisper_buffer.clear()
                continue

            if active:
                if not collecting_for_whisper:
                    for chunk in pre_buffer:
                        whisper_buffer.extend(chunk)
                collecting_for_whisper = True
                whisper_buffer.extend(data)
                last_voice_time = time.time()
        else:
            if active:
                energy = rms(np.frombuffer(data, dtype=np.int16))
                if energy > ENERGY_THRESHOLD:
                    if not collecting_for_whisper:
                        for chunk in pre_buffer:
                            whisper_buffer.extend(chunk)
                    collecting_for_whisper = True
                    last_voice_time = time.time()
                if collecting_for_whisper:
                    whisper_buffer.extend(data)

                if collecting_for_whisper and (time.time() - last_voice_time) > SILENCE_TIMEOUT:
                    flush_to_whisper()


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

    def on_wake(target_name=None):
        global active
        was_active = active
        active = True
        if not was_active:
            emit("wake", state="on", target=target_name or "")
            threading.Thread(target=get_whisper_model, daemon=True).start()
        else:
            # Keep-alive ping -- pass target if changed
            emit("wake", state="ping", target=target_name or "")

    def on_timeout():
        global active
        if active:
            active = False
            emit("wake", state="off", reason="timeout")

    # Start whisper transcription worker thread
    worker = threading.Thread(target=whisper_worker, daemon=True)
    worker.start()

    # Watch stdin for close (graceful shutdown signal from Node.js)
    def watch_stdin():
        global running
        try:
            while True:
                line = sys.stdin.readline()
                if not line:  # stdin closed
                    break
        except Exception:
            pass
        running = False

    stdin_watcher = threading.Thread(target=watch_stdin, daemon=True)
    stdin_watcher.start()

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
        run_vosk_detector(on_wake, on_timeout)
    except KeyboardInterrupt:
        pass
    finally:
        running = False
        transcription_queue.put(None)  # poison pill for worker
        stream.stop()
        stream.close()
        worker.join(timeout=5.0)
        emit("status", message="Listener stopped")


if __name__ == "__main__":
    main()
