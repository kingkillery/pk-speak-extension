---
name: multimodalart-higgs-audio-v3-tts
description: Use the multimodalart/higgs-audio-v3-tts Gradio Space via API. Provides Python, JavaScript, and cURL usage examples.
---

# multimodalart/higgs-audio-v3-tts

This skill describes how to use the multimodalart/higgs-audio-v3-tts Gradio Space programmatically.

## API Endpoints

### `/transcribe`

**Parameters:**

- `reference_audio` [Audio]: `filepath` (required)

**Returns:**

- `Reference transcript (auto-filled on upload, improves cloning)` [Textbox]: `str`

**Python:**

```python
from gradio_client import Client, handle_file

client = Client("multimodalart/higgs-audio-v3-tts")
result = client.predict(
	reference_audio=handle_file('https://github.com/gradio-app/gradio/raw/main/test/test_files/audio_sample.wav'),
	api_name="/transcribe",
)
print(result)
```

**JavaScript:**

```javascript
import { Client } from "@gradio/client";

const response_0 = await fetch("https://github.com/gradio-app/gradio/raw/main/test/test_files/audio_sample.wav");
const exampleAudio = await response_0.blob();

const client = await Client.connect("multimodalart/higgs-audio-v3-tts");
const result = await client.predict("/transcribe", {
		reference_audio: exampleAudio,
});

console.log(result.data);
```

**cURL:**

```bash
FILE_PATH=$(curl -s -X POST https://multimodalart-higgs-audio-v3-tts.hf.space/upload -F 'files=@/path/to/your/file' | tr -d '[]" ')

curl -X POST https://multimodalart-higgs-audio-v3-tts.hf.space/call/v2/transcribe -s -H "Content-Type: application/json" \
  -d '{"reference_audio": {"path": "'$FILE_PATH'", "meta": {"_type": "gradio.FileData"}}}' \
  | awk -F'"' '{ print $4}' \
  | read EVENT_ID; curl -N https://multimodalart-higgs-audio-v3-tts.hf.space/call/transcribe/$EVENT_ID
```

### `/synthesize`

**Parameters:**

- `text` [Textbox]: `str` (required)
- `reference_audio` [Audio]: `filepath` (required)
- `reference_text` [Textbox]: `str` (required)
- `temperature` [Slider]: `float`, default: `0.7`
- `top_p` [Slider]: `float`, default: `0.95`
- `top_k` [Slider]: `float`, default: `50`
- `max_new_tokens` [Slider]: `float`, default: `2048`
- `seed` [Number]: `int`, default: `-1`

**Returns:**

- `Generated speech` [Audio]: `filepath`

**Python:**

```python
from gradio_client import Client, handle_file

client = Client("multimodalart/higgs-audio-v3-tts")
result = client.predict(
	text="Hello!!",
	reference_audio=handle_file('https://github.com/gradio-app/gradio/raw/main/test/test_files/audio_sample.wav'),
	reference_text="Hello!!",
	temperature=0.7,
	top_p=0.95,
	top_k=50,
	max_new_tokens=2048,
	seed=-1,
	api_name="/synthesize",
)
print(result)
```

**JavaScript:**

```javascript
import { Client } from "@gradio/client";

const response_0 = await fetch("https://github.com/gradio-app/gradio/raw/main/test/test_files/audio_sample.wav");
const exampleAudio = await response_0.blob();

const client = await Client.connect("multimodalart/higgs-audio-v3-tts");
const result = await client.predict("/synthesize", {
		text: "Hello!!",
		reference_audio: exampleAudio,
		reference_text: "Hello!!",
		temperature: 0.7,
		top_p: 0.95,
		top_k: 50,
		max_new_tokens: 2048,
		seed: -1,
});

console.log(result.data);
```

**cURL:**

```bash
FILE_PATH=$(curl -s -X POST https://multimodalart-higgs-audio-v3-tts.hf.space/upload -F 'files=@/path/to/your/file' | tr -d '[]" ')

curl -X POST https://multimodalart-higgs-audio-v3-tts.hf.space/call/v2/synthesize -s -H "Content-Type: application/json" \
  -d '{"text": "Hello!!", "reference_audio": {"path": "'$FILE_PATH'", "meta": {"_type": "gradio.FileData"}}, "reference_text": "Hello!!", "temperature": 0.7, "top_p": 0.95, "top_k": 50, "max_new_tokens": 2048, "seed": -1}' \
  | awk -F'"' '{ print $4}' \
  | read EVENT_ID; curl -N https://multimodalart-higgs-audio-v3-tts.hf.space/call/synthesize/$EVENT_ID
```

