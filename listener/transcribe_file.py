import json
import os
import sys


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing input file"}))
        sys.exit(1)

    input_path = sys.argv[1]
    if not os.path.exists(input_path):
        print(json.dumps({"success": False, "error": f"Input file not found: {input_path}"}))
        sys.exit(1)

    model_size = os.environ.get("PI_SPEAK_REMOTE_WHISPER_MODEL") or os.environ.get("WHISPER_MODEL") or "base"
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute = os.environ.get("WHISPER_COMPUTE", "int8")

    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(model_size, device=device, compute_type=compute)
        segments, _info = model.transcribe(
            input_path,
            beam_size=5,
            language="en",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        text = " ".join(seg.text.strip() for seg in segments if seg.text and seg.text.strip()).strip()
        print(json.dumps({"success": True, "text": text}))
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
