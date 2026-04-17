"""
Two-tier voice listener for pi-speak-extension.

Tier 1: faster-whisper tiny performs lightweight wake-phrase detection for the
        default wake phrase "PK" (configurable via PI_SPEAK_WAKE_PHRASE).
        Saying the wake phrase activates voice input. It stays active as long as
        the wake phrase is heard again within ACTIVITY_TIMEOUT seconds.
Tier 2: faster-whisper transcribes full speech for Pi messages.

Outputs JSON lines to stdout for the Node.js extension to consume.
"""

from __future__ import annotations

import collections
import json
import os
import queue
import re
import sys
import threading
import time
from typing import Literal

import numpy as np
import sounddevice as sd

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
SAMPLE_RATE = 16000
WHISPER_MODEL = "tiny"
WAKE_PHRASE_DISPLAY = (os.environ.get("PI_SPEAK_WAKE_PHRASE") or "PK").strip() or "PK"
ACTIVITY_TIMEOUT = float(
    os.environ.get("PI_SPEAK_MONO_ACTIVITY_TIMEOUT")
    or os.environ.get("MONO_ACTIVITY_TIMEOUT")
    or "15.0"
)
WAKE_SILENCE_TIMEOUT = float(os.environ.get("PI_SPEAK_WAKE_SILENCE_TIMEOUT", "0.8"))
SPEECH_SILENCE_TIMEOUT = float(os.environ.get("PI_SPEAK_SPEECH_SILENCE_TIMEOUT", "1.4"))
ENERGY_THRESHOLD = float(os.environ.get("PI_SPEAK_ENERGY_THRESHOLD", "150"))
PRE_BUFFER_CHUNKS = int(os.environ.get("PI_SPEAK_PRE_BUFFER_CHUNKS", "6"))
MAX_AUDIO_QUEUE_CHUNKS = int(os.environ.get("PI_SPEAK_AUDIO_QUEUE_CHUNKS", "48"))
MAX_SEGMENT_QUEUE_ITEMS = int(os.environ.get("PI_SPEAK_SEGMENT_QUEUE_ITEMS", "4"))
MAX_SEGMENT_SECONDS = float(os.environ.get("PI_SPEAK_MAX_SEGMENT_SECONDS", "8.0"))
OVERFLOW_WARN_INTERVAL = float(os.environ.get("PI_SPEAK_OVERFLOW_WARN_INTERVAL", "5.0"))
WAKE_SENSITIVITY = (os.environ.get("PI_SPEAK_WAKE_SENSITIVITY") or "medium").strip().lower() or "medium"

SegmentKind = Literal["wake", "speech"]


audio_queue: queue.Queue[bytes] = queue.Queue(maxsize=MAX_AUDIO_QUEUE_CHUNKS)
segment_queue: queue.Queue[tuple[SegmentKind, bytes] | None] = queue.Queue(maxsize=MAX_SEGMENT_QUEUE_ITEMS)
active = False
last_wake_time = 0.0
running = True
last_overflow_warning_at = 0.0
audio_chunks_dropped = 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def emit(event_type: str, **kwargs):
    payload = {"type": event_type, **kwargs}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def get_env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


_wakeup_variants: tuple[str, ...] | None = None
_wakeup_compact_variants: tuple[str, ...] | None = None


def normalize_text(text: str) -> str:
    lowered = text.lower().replace(".", " ")
    lowered = re.sub(r"[^a-z0-9_\-\s]", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def parse_bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "off", "no"}


def compact_text(text: str) -> str:
    return text.replace(" ", "")


def get_wake_fuzzy_enabled() -> bool:
    default = WAKE_SENSITIVITY in {"medium", "high"}
    return parse_bool_env("PI_SPEAK_WAKE_FUZZY_ENABLED", default)


def get_wake_compact_prefix_enabled() -> bool:
    default = WAKE_SENSITIVITY in {"medium", "high"}
    return parse_bool_env("PI_SPEAK_WAKE_COMPACT_PREFIX_ENABLED", default)


def get_wake_fuzzy_max_distance() -> int:
    configured = os.environ.get("PI_SPEAK_WAKE_FUZZY_MAX_DISTANCE")
    if configured is not None and configured.strip():
        try:
            return max(0, int(configured.strip()))
        except ValueError:
            return 1
    if WAKE_SENSITIVITY == "high":
        return 2
    if WAKE_SENSITIVITY == "low":
        return 0
    return 1


def get_wake_variants() -> tuple[str, ...]:
    global _wakeup_variants
    if _wakeup_variants is not None:
        return _wakeup_variants

    normalized = normalize_text(WAKE_PHRASE_DISPLAY)
    variants: list[str] = [normalized]
    if normalized == "pk":
        variants.extend([
            "p k",
            "pee kay",
            "pea kay",
            "pee key",
            "pea key",
            "peekay",
            "peekey",
            "pkay",
            "pee k",
            "pea k",
            "okay pk",
            "ok pk",
            "okay p k",
            "ok p k",
            "okay pee kay",
            "ok pee kay",
            "okay peekay",
            "ok peekay",
        ])
    deduped: list[str] = []
    seen: set[str] = set()
    for variant in variants:
        if variant and variant not in seen:
            deduped.append(variant)
            seen.add(variant)
    _wakeup_variants = tuple(deduped)
    return _wakeup_variants


def get_wake_compact_variants() -> tuple[str, ...]:
    global _wakeup_compact_variants
    if _wakeup_compact_variants is not None:
        return _wakeup_compact_variants

    compact_variants: list[str] = []
    seen: set[str] = set()
    for variant in get_wake_variants():
        compact = compact_text(variant)
        if compact and compact not in seen:
            compact_variants.append(compact)
            seen.add(compact)
    _wakeup_compact_variants = tuple(compact_variants)
    return _wakeup_compact_variants


def levenshtein_distance(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    if len(left) < len(right):
        left, right = right, left

    previous = list(range(len(right) + 1))
    for i, left_char in enumerate(left, start=1):
        current = [i]
        for j, right_char in enumerate(right, start=1):
            insert_cost = current[j - 1] + 1
            delete_cost = previous[j] + 1
            replace_cost = previous[j - 1] + (0 if left_char == right_char else 1)
            current.append(min(insert_cost, delete_cost, replace_cost))
        previous = current
    return previous[-1]


def fuzzy_matches_wake(candidate: str) -> bool:
    if not get_wake_fuzzy_enabled():
        return False
    normalized = compact_text(normalize_text(candidate))
    if not normalized:
        return False

    max_distance = get_wake_fuzzy_max_distance()
    for variant in get_wake_compact_variants():
        if normalized == variant:
            return True
        if abs(len(normalized) - len(variant)) > max_distance:
            continue
        if normalized[0] != variant[0]:
            continue
        if levenshtein_distance(normalized, variant) <= max_distance:
            return True
    return False


def detect_wake_phrase(text: str) -> str | None:
    normalized = normalize_text(text)
    if not normalized:
        return None

    for variant in get_wake_variants():
        if normalized == variant:
            return ""
        prefix = variant + " "
        if normalized.startswith(prefix):
            return normalized[len(prefix):].strip()

    compact = compact_text(normalized)
    if get_wake_compact_prefix_enabled():
        for variant in get_wake_compact_variants():
            if compact == variant:
                return ""
            if compact.startswith(variant) and len(compact) > len(variant):
                return compact[len(variant):].strip()

    words = normalized.split()
    if not words:
        return None

    if fuzzy_matches_wake(words[0]):
        return " ".join(words[1:]).strip()
    if len(words) >= 2 and fuzzy_matches_wake(" ".join(words[:2])):
        return " ".join(words[2:]).strip()
    if len(words) <= 2 and fuzzy_matches_wake(normalized):
        return ""

    if get_wake_compact_prefix_enabled():
        compact_first = compact_text(words[0])
        for variant in get_wake_compact_variants():
            if compact_first.startswith(variant) and len(compact_first) > len(variant):
                return compact_first[len(variant):].strip()
    return None


def rms(data: np.ndarray) -> float:
    return float(np.sqrt(np.mean(data.astype(np.float32) ** 2))) if data.size else 0.0


def warn_input_overflow(message: str):
    global last_overflow_warning_at
    now = time.time()
    if (now - last_overflow_warning_at) < OVERFLOW_WARN_INTERVAL:
        return
    last_overflow_warning_at = now
    emit("status", message=message)


def enqueue_segment(kind: SegmentKind, audio_bytes: bytes):
    if len(audio_bytes) < SAMPLE_RATE * 2:
        return
    item = (kind, audio_bytes)
    if segment_queue.full():
        try:
            segment_queue.get_nowait()
        except queue.Empty:
            pass
    segment_queue.put(item)


# ---------------------------------------------------------------------------
# Audio capture callback
# ---------------------------------------------------------------------------
def audio_callback(indata, frames, time_info, status):
    global audio_chunks_dropped
    if status:
        status_text = str(status)
        if getattr(status, "input_overflow", False):
            warn_input_overflow("Audio input overflow detected; dropping stale audio and continuing.")
        else:
            emit("error", message=status_text)

    chunk = bytes(indata)
    try:
        audio_queue.put_nowait(chunk)
    except queue.Full:
        audio_chunks_dropped += 1
        try:
            audio_queue.get_nowait()
        except queue.Empty:
            pass
        try:
            audio_queue.put_nowait(chunk)
        except queue.Full:
            pass
        warn_input_overflow(
            f"Audio capture queue overflowed; dropped {audio_chunks_dropped} chunk(s) to stay real-time."
        )


# ---------------------------------------------------------------------------
# faster-whisper model
# ---------------------------------------------------------------------------
_whisper_model = None
_whisper_lock = threading.Lock()


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel

                device = get_env("WHISPER_DEVICE", "cpu")
                compute = get_env("WHISPER_COMPUTE", "int8")
                model_size = get_env("WHISPER_MODEL", WHISPER_MODEL)
                emit("status", message=f"Loading whisper model ({model_size}, {device}, {compute})...")
                _whisper_model = WhisperModel(model_size, device=device, compute_type=compute)
                emit("status", message="Whisper model loaded")
    return _whisper_model


def transcribe_audio(audio_bytes: bytes, purpose: SegmentKind | Literal["speech-active"] = "speech") -> str:
    model = get_whisper_model()
    audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    beam_size = 1 if purpose == "wake" else 3
    segments, _info = model.transcribe(
        audio_np,
        beam_size=beam_size,
        best_of=beam_size,
        language="en",
        condition_on_previous_text=False,
        vad_filter=False,
        temperature=0.0,
    )
    parts = [seg.text.strip() for seg in segments if seg.text.strip()]
    return " ".join(parts)


# ---------------------------------------------------------------------------
# Worker threads
# ---------------------------------------------------------------------------
def transcription_worker(on_wake, on_timeout):
    global last_wake_time
    while running:
        try:
            item = segment_queue.get(timeout=1.0)
        except queue.Empty:
            continue
        if item is None:
            break

        kind, audio_bytes = item
        try:
            text = transcribe_audio(audio_bytes, purpose=kind)
        except Exception as exc:
            emit("error", message=f"Transcription failed: {exc}")
            continue

        if not text:
            continue

        target = detect_wake_phrase(text)
        if target is not None:
            last_wake_time = time.time()
            on_wake(target or None)
            continue

        if kind == "speech":
            emit("transcribing")
            emit("speech", text=text)


# ---------------------------------------------------------------------------
# Audio segmentation loop
# ---------------------------------------------------------------------------
def run_audio_loop(on_wake, on_timeout):
    collecting = False
    segment_buffer = bytearray()
    pre_buffer: collections.deque[bytes] = collections.deque(maxlen=PRE_BUFFER_CHUNKS)
    last_voice_time = 0.0

    def flush_segment(force_kind: SegmentKind | None = None):
        nonlocal collecting, last_voice_time
        if not segment_buffer:
            collecting = False
            return
        kind: SegmentKind = force_kind or ("speech" if active else "wake")
        enqueue_segment(kind, bytes(segment_buffer))
        segment_buffer.clear()
        collecting = False
        last_voice_time = 0.0

    def current_silence_timeout() -> float:
        return SPEECH_SILENCE_TIMEOUT if active else WAKE_SILENCE_TIMEOUT

    def check_activity_timeout():
        if active and last_wake_time > 0 and (time.time() - last_wake_time) > ACTIVITY_TIMEOUT:
            if collecting:
                flush_segment("speech")
            on_timeout()

    max_segment_bytes = int(MAX_SEGMENT_SECONDS * SAMPLE_RATE * 2)

    while running:
        try:
            data = audio_queue.get(timeout=0.25)
        except queue.Empty:
            check_activity_timeout()
            if collecting and last_voice_time > 0 and (time.time() - last_voice_time) > current_silence_timeout():
                flush_segment()
            continue

        check_activity_timeout()
        pre_buffer.append(data)
        samples = np.frombuffer(data, dtype=np.int16)
        energy = rms(samples)
        has_voice = energy >= ENERGY_THRESHOLD

        if collecting:
            segment_buffer.extend(data)
            if has_voice:
                last_voice_time = time.time()
            if len(segment_buffer) >= max_segment_bytes:
                flush_segment()
                continue
            if last_voice_time > 0 and (time.time() - last_voice_time) > current_silence_timeout():
                flush_segment()
            continue

        if has_voice:
            collecting = True
            for chunk in pre_buffer:
                segment_buffer.extend(chunk)
            last_voice_time = time.time()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    global active, running

    emit("status", message="Voice listener starting...")
    emit("status", message=f"Wake phrase ready: {WAKE_PHRASE_DISPLAY}")
    emit(
        "status",
        message=(
            f"Wake sensitivity: {WAKE_SENSITIVITY} "
            f"(fuzzy={'on' if get_wake_fuzzy_enabled() else 'off'}, "
            f"compact={'on' if get_wake_compact_prefix_enabled() else 'off'}, "
            f"distance={get_wake_fuzzy_max_distance()})"
        ),
    )

    def on_wake(target_name=None):
        global active
        was_active = active
        active = True
        if not was_active:
            emit("wake", state="on", target=target_name or "")
        else:
            emit("wake", state="ping", target=target_name or "")

    def on_timeout():
        global active
        if active:
            active = False
            emit("wake", state="off", reason="timeout")

    worker = threading.Thread(target=transcription_worker, args=(on_wake, on_timeout), daemon=True)
    worker.start()

    model_loader = threading.Thread(target=get_whisper_model, daemon=True)
    model_loader.start()

    def watch_stdin():
        global running
        try:
            while True:
                line = sys.stdin.readline()
                if not line:
                    break
                command = line.strip().lower()
                if command in {"shutdown", "stop", "exit", "quit"}:
                    emit("status", message="Shutdown requested")
                    break
        except Exception:
            pass
        running = False

    stdin_watcher = threading.Thread(target=watch_stdin, daemon=True)
    stdin_watcher.start()

    try:
        stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            blocksize=0,
            dtype="int16",
            channels=1,
            latency="high",
            callback=audio_callback,
        )
        stream.start()
        emit("status", message="Listening (waiting for wake phrase)")
    except Exception as exc:
        emit("error", message=f"Failed to open audio stream: {exc}")
        sys.exit(1)

    try:
        run_audio_loop(on_wake, on_timeout)
    except KeyboardInterrupt:
        pass
    finally:
        running = False
        if segment_queue.full():
            try:
                segment_queue.get_nowait()
            except queue.Empty:
                pass
        segment_queue.put(None)
        stream.stop()
        stream.close()
        worker.join(timeout=5.0)
        emit("status", message="Listener stopped")


if __name__ == "__main__":
    main()
