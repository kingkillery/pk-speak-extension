# pk-speak CLI

Run these commands from the repository root. Start with `--help`; use `--dry-run` (where supported) to print the resolved plan without spawning subprocesses, opening network ports, writing files, or playing audio.

## Prerequisites

- Node.js 22+
- Build outputs under `dist/` for commands that launch compiled entrypoints (`gateway`, `tray`, `admin`, `setup`). Run `npm run build` (and `npm run build:ui` when using `admin`) before live runs.
- A saved setup profile from `pi-speak-pk` / `pk-speak setup` for doctor/config/speak live paths.
- Live `brainstorm` requires a running gateway (`pk-speak gateway`) that exposes `/v1/brainstorm`.
- `--dry-run` does not require audio hardware, network access, or built UI assets beyond reading paths for the printed plan.

## Global

```bash
node ./dist/pk-speak.js --version
node ./dist/pk-speak.js help
node ./dist/pk-speak.js --help
```

`--version` prints the version from `package.json` and exits 0.

## `setup`

First-time setup via `pi-speak-pk`. **`--dry-run` is not supported.**

```bash
node ./dist/pk-speak.js setup --help
node ./dist/pk-speak.js setup
```

## `doctor`

Shows configured backend, voice, APK, and gateway status inputs.

```bash
node ./dist/pk-speak.js doctor --help
node ./dist/pk-speak.js doctor --dry-run
node ./dist/pk-speak.js doctor
```

`--dry-run` prints the plan and does not spawn `powershell.exe` or mutate state.

## `speak`

Speaks text from arguments, stdin, or an audio file using configured TTS. Supports `--dry-run`.

```bash
node ./dist/pk-speak.js speak --help
node ./dist/pk-speak.js speak --dry-run "Tests passed"
node ./dist/pk-speak.js speak "Tests passed"
```

## `wrap`

Runs a CLI command and speaks start/finish notices. Supports `--dry-run`.

```bash
node ./dist/pk-speak.js wrap --help
node ./dist/pk-speak.js wrap --dry-run -- npm test
node ./dist/pk-speak.js wrap -- npm test
```

## `brainstorm`

Posts brainstorm audio to the gateway for WhisperX transcription and structuring. Supports `--dry-run`.

```bash
node ./dist/pk-speak.js brainstorm --help
node ./dist/pk-speak.js brainstorm recording.wav --dry-run
node ./dist/pk-speak.js brainstorm recording.wav
```

`--dry-run` prints host/port/path plan details and does not read the audio payload or make a network call.

## `gateway`

Starts the headless phone/control gateway (`dist/headless-gateway.js`). Supports `--dry-run`.

```bash
node ./dist/pk-speak.js gateway --help
node ./dist/pk-speak.js gateway --dry-run
node ./dist/pk-speak.js gateway
node ./dist/pk-speak.js gateway --live
```

If `dist/headless-gateway.js` is missing, live runs exit non-zero with `<path>: not built — run npm run build`. Dry-run prints the same missing-build note without spawning Node.

## `tray`

Starts the Windows tray controller (`dist/persistent-tray.js`). Supports `--dry-run`.

```bash
node ./dist/pk-speak.js tray --help
node ./dist/pk-speak.js tray --dry-run
node ./dist/pk-speak.js tray
```

## `mobile`

Prints the Android setup/download QR via `scripts/qr-setup.mjs`. Supports `--dry-run`.

```bash
node ./dist/pk-speak.js mobile --help
node ./dist/pk-speak.js mobile --dry-run
node ./dist/pk-speak.js mobile
```

## `admin`

Opens the sessions admin pane (`dist/ui/admin.js`). Supports `--dry-run`.

```bash
node ./dist/pk-speak.js admin --help
node ./dist/pk-speak.js admin --dry-run
node ./dist/pk-speak.js admin
```

## `config`

Shows the saved setup profile path and masked values. Supports `--dry-run`.

```bash
node ./dist/pk-speak.js config --help
node ./dist/pk-speak.js config --dry-run
node ./dist/pk-speak.js config
```

`--dry-run` prints the plan and does not write files.

## Smoke testing

Text-only `/v1/live` smoke (no audio): `node ./dist/scripts/synthetic-live-smoke.js --dry-run` prints the plan; omit `--dry-run` to send `{ type: "text" }` turns against a running `pk-speak gateway` (`--help` lists host/port/token/turns/timeout flags).
## Benchmarking

Provider latency harnesses for TTS (`synthesizeToFile`) and STT (`transcribeAudioBuffer`). Live runs print a stdout results table and write JSON to `--output`. `--dry-run` validates inputs and prints the planned providers/iterations/output (and TTS text / STT audio path) without loading models, decoding audio, calling providers (including Google), printing the results table, or writing JSON. STT requires `--audio-file` and exits 1 if the path is missing (including dry-run). Default STT providers are `local openai elevenlabs`; `google` is valid when passed explicitly.

Live `google` STT uses Google Cloud Speech-to-Text v2 with Google Cloud ADC from `gcloud auth application-default login` (not Gemini TTS; `PI_SPEAK_VERTEX_API_KEY` does not authenticate Speech STT): enable the Speech-to-Text API, resolve project via `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` / `PI_SPEAK_VERTEX_PROJECT` then ADC discovery, and optionally set `PI_SPEAK_GOOGLE_STT_LOCATION`, `PI_SPEAK_GOOGLE_STT_MODEL`, and `PI_SPEAK_STT_LANGUAGE` (defaults: Google `en-US`, ElevenLabs `en`; the same env feeds both).

```bash
node ./dist/scripts/benchmark-tts.js --help
node ./dist/scripts/benchmark-tts.js --dry-run --text "hello"
node ./dist/scripts/benchmark-tts.js --text "hello" --providers edge --iterations 3

node ./dist/scripts/benchmark-stt.js --help
node ./dist/scripts/benchmark-stt.js --dry-run --audio-file sample.wav
node ./dist/scripts/benchmark-stt.js --dry-run --audio-file sample.wav --providers google
node ./dist/scripts/benchmark-stt.js --audio-file sample.wav --providers local --iterations 3
```

Build first (`npm run build`) so `dist/scripts/benchmark-*.js` exist.

## Windows notes

- From PowerShell in the repo root, prefer `node .\dist\pk-speak.js ...` after `npm run build`.
- Paths in dry-run output use the resolved absolute `dist/` location for this checkout.
- `doctor` live mode may query Windows user environment variables through PowerShell; `doctor --dry-run` skips that.
- If a `dist/` target is missing after a clean checkout, run `npm run build` (and `npm run build:ui` for admin) before live commands.
