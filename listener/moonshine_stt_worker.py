import json
import os
import sys
from importlib.metadata import PackageNotFoundError, version as package_version
from pathlib import Path


_transcriber = None
_model_path = None
_model_arch = None


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def get_env(name, default=""):
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def error_payload(code, phase, message):
    return {
        "code": code,
        "phase": phase,
        "message": " ".join(str(message or code).split())[:500],
    }


def initialize():
    global _transcriber, _model_path, _model_arch
    try:
        from moonshine_voice import ModelArch, Transcriber, get_model_for_language
    except (ModuleNotFoundError, PackageNotFoundError) as exc:
        raise RuntimeError(json.dumps(error_payload("dependency_unavailable", "bootstrap", exc))) from exc

    try:
        explicit_path = get_env("PI_SPEAK_MOONSHINE_MODEL_PATH")
        if explicit_path:
            model_path = Path(explicit_path).expanduser().resolve()
            if not model_path.exists():
                raise FileNotFoundError(f"Moonshine model path does not exist: {model_path}")
            model_arch = ModelArch.BASE
        else:
            model_path, model_arch = get_model_for_language("en", wanted_model_arch=ModelArch.BASE)
        _transcriber = Transcriber(model_path=model_path, model_arch=model_arch)
        _model_path = str(model_path)
        _model_arch = model_arch.name.lower()
    except Exception as exc:
        raise RuntimeError(json.dumps(error_payload("model_unavailable", "model", exc))) from exc


def decode_audio(input_path):
    try:
        from faster_whisper.audio import decode_audio as decode_with_faster_whisper
    except Exception as exc:
        raise RuntimeError(json.dumps(error_payload("dependency_unavailable", "decode", exc))) from exc
    try:
        audio = decode_with_faster_whisper(input_path, sampling_rate=16000)
    except Exception as exc:
        raise RuntimeError(json.dumps(error_payload("invalid_audio", "decode", exc))) from exc
    if audio is None or len(audio) == 0:
        raise RuntimeError(json.dumps(error_payload("invalid_audio", "decode", "Audio payload is empty")))
    max_seconds = max(1.0, float(get_env("PI_SPEAK_MOONSHINE_MAX_AUDIO_SECONDS", "30")))
    duration_seconds = len(audio) / 16000.0
    if duration_seconds > max_seconds:
        raise RuntimeError(
            json.dumps(
                error_payload(
                    "invalid_audio",
                    "decode",
                    f"Decoded audio duration {duration_seconds:.1f}s exceeds Moonshine limit {max_seconds:.1f}s",
                )
            )
        )
    return audio


def transcribe_file(input_path):
    if not os.path.exists(input_path):
        raise RuntimeError(json.dumps(error_payload("invalid_audio", "decode", "Input audio file does not exist")))
    audio = decode_audio(input_path)
    try:
        transcript = _transcriber.transcribe_without_streaming(audio, sample_rate=16000)
        return " ".join(
            line.text.strip()
            for line in transcript.lines
            if line.text and line.text.strip()
        ).strip()
    except Exception as exc:
        raise RuntimeError(json.dumps(error_payload("inference_failed", "inference", exc))) from exc


def parse_structured_error(exc):
    try:
        value = json.loads(str(exc))
        if isinstance(value, dict) and isinstance(value.get("code"), str):
            return value
    except Exception:
        pass
    return error_payload("unknown", "worker", exc)


def close_transcriber():
    global _transcriber
    transcriber = _transcriber
    _transcriber = None
    if transcriber is not None:
        try:
            transcriber.close()
        except Exception:
            pass


def main():
    try:
        initialize()
        try:
            installed_version = package_version("moonshine-voice")
        except PackageNotFoundError:
            installed_version = "unknown"
        emit(
            {
                "type": "ready",
                "backend": "moonshine",
                "packageVersion": installed_version,
                "modelArch": _model_arch,
            }
        )
    except Exception as exc:
        emit({"type": "fatal", "backend": "moonshine", "error": parse_structured_error(exc)})
        return 1

    try:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            request_id = None
            try:
                request = json.loads(line)
                request_id = request.get("id")
                if request.get("type") == "shutdown":
                    break
                if request.get("type", "transcribe") != "transcribe" or not request_id:
                    raise ValueError("Invalid Moonshine worker request")
                text = transcribe_file(request["file_path"])
                emit(
                    {
                        "type": "result",
                        "id": request_id,
                        "ok": True,
                        "text": text,
                        "backend": "moonshine",
                        "modelArch": _model_arch,
                    }
                )
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                emit(
                    {
                        "type": "result",
                        "id": request_id,
                        "ok": False,
                        "error": error_payload("protocol", "request", exc),
                    }
                )
            except Exception as exc:
                emit(
                    {
                        "type": "result",
                        "id": request_id,
                        "ok": False,
                        "error": parse_structured_error(exc),
                    }
                )
    finally:
        close_transcriber()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
