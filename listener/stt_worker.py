import json
import os
import sys
from threading import Lock


_model = None
_model_lock = Lock()


def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def get_env(name, default=""):
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                from faster_whisper import WhisperModel

                model_size = get_env("PI_SPEAK_REMOTE_WHISPER_MODEL") or get_env("WHISPER_MODEL") or "base"
                device = get_env("WHISPER_DEVICE", "cpu")
                compute = get_env("WHISPER_COMPUTE", "int8")
                _model = WhisperModel(model_size, device=device, compute_type=compute)
    return _model


def transcribe_file(input_path):
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")

    model = get_model()
    segments, _info = model.transcribe(
        input_path,
        beam_size=5,
        language="en",
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )
    return " ".join(seg.text.strip() for seg in segments if seg.text and seg.text.strip()).strip()


def main():
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            request_id = payload["id"]
            input_path = payload["file_path"]
            text = transcribe_file(input_path)
            emit({"id": request_id, "ok": True, "text": text})
        except Exception as exc:  # noqa: BLE001 - return structured error to parent
            emit(
                {
                    "id": payload.get("id") if isinstance(payload, dict) else None,
                    "ok": False,
                    "error": str(exc),
                }
            )


if __name__ == "__main__":
    main()
