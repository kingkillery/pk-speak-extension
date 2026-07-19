import sys
import os
import json
import gc

def get_env(name, default=""):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip() or default

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing input file"}))
        sys.exit(1)
        
    input_path = sys.argv[1]
    if not os.path.exists(input_path):
        print(json.dumps({"success": False, "error": f"Input file not found: {input_path}"}))
        sys.exit(1)
        
    # Default to cuda for WhisperX since we want GPU speed!
    device = get_env("WHISPER_DEVICE", "cuda")
    compute_type = get_env("WHISPER_COMPUTE", "float16")
    model_size = get_env("WHISPER_MODEL", "large-v2")
    
    try:
        import whisperx
        import torch
        
        # Load model on-demand
        model = whisperx.load_model(model_size, device, compute_type=compute_type)
        audio = whisperx.load_audio(input_path)
        
        # Transcribe with batched inference
        result = model.transcribe(audio, batch_size=16)
        
        # Combine segments into a cohesive text transcript
        text = " ".join(seg["text"].strip() for seg in result["segments"] if seg.get("text")).strip()
        
        # Clean up models to free GPU VRAM immediately
        del model
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            
        print(json.dumps({"success": True, "text": text}))
        
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
