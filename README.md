# pi-speak-extension

Real `/speak` command for pi / pi-mono.

What it does:
- toggles spoken assistant replies on and off
- injects speech-first CodeChat behavior into the system prompt
- preserves the full on-screen pi response
- sends the spoken version through this flow:
  1. user submits text
  2. pi produces the full assistant response
  3. `speak11` rewrites that response through OpenRouter model `openai/gpt-oss-20b:nitro`
  4. the rewritten text is voiced through the ElevenLabs API using the `adam` voice
- shows per-turn pipeline status in pi's status line:
  - `llm`
  - `rewrite`
  - `elevenlabs`
  - `playing`

## Usage

After reloading pi:

```text
/speak
/speak test
/speak stop
/speak off
/speak status
/speak explain the auth flow
```

## Dependencies

- `speak11.py` / `speak11.cmd`
- OpenRouter rewrite model: `openai/gpt-oss-20b:nitro`
- ElevenLabs API voice output (default voice: `adam`)

## Interrupting playback

Use:

```text
/speak stop
```

That stops the current spoken reply immediately but keeps speak mode enabled.

Use:

```text
/speak off
```

That stops playback and disables speak mode entirely.
