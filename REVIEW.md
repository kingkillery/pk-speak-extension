# pi-speak-extension — Deep Code Review

**Date:** 2026-04-12
**Scope:** `index.ts` (extension), `listener/listener.py` (voice listener), `package.json`, built output `dist/index.js`

---

## Critical Issues

### 1. `getExtensionDir()` returns wrong path when installed via npm
- **Severity:** Critical
- **File:** `index.ts:93` / `dist/index.js`
- **Description:** `getExtensionDir()` returns `__dirname`, which resolves to the `dist/` subdirectory at runtime (since `main` is `dist/index.js`). The listener script is loaded via `join(extDir, "listener", "listener.py")`, which resolves to `dist/listener/listener.py`. However, the `listener/` directory is a sibling of `dist/`, not a child — so the file doesn't exist at that path when the package is installed via npm (`node_modules/pi-speak-pk/dist/` vs `node_modules/pi-speak-pk/listener/`).
- **Impact:** The `/mono on` command **cannot work at all** when the extension is installed from npm. `startListener` will hit the `!existsSync(listenerScript)` guard and notify the user the script is not found.
- **Fix:** Change `getExtensionDir()` to `return join(__dirname, "..")` or resolve to the package root.

### 2. Audio queue stalls during whisper transcription (listener blocks real-time)
- **Severity:** Critical
- **File:** `listener/listener.py:87-109` (run_vosk_detector), `listener/listener.py:130-140` (on_speech callback in main)
- **Description:** `on_speech(audio_bytes)` is called synchronously from within the `run_vosk_detector` loop running on the main thread. `transcribe_audio()` can take 1-5+ seconds. During this time, `audio_queue.get()` is not being called — but `audio_callback` keeps pushing data. After transcription finishes, the queued audio is stale (past audio processed as if it were current), Vosk falls behind real-time, and timing-dependent features (silence timeout, energy threshold) become unreliable.
- **Impact:** After every whisper transcription, Vosk processes a backlog of stale audio. Wake phrase detection and speech collection become unreliable. The system may hallucinate additional utterances from the stale buffer.
- **Fix:** Run `on_speech` in a separate thread (e.g., `threading.Thread(target=on_speech, args=(audio_bytes,), daemon=True).start()`) or use a dedicated transcription queue with a worker thread.

---

## High Issues

### 3. Stale `ctx` captured in listener readline closure
- **Severity:** High
- **File:** `index.ts:208-214`
- **Description:** `startListener(ctx)` captures `ctx` in the `rl.on("line", ...)` closure. `handleListenerEvent(event, ctx)` then uses `const target = ctx || lastCtx`. Since `ctx` is never undefined (it was passed to `startListener`), `lastCtx` is never consulted — the listener always uses the context from when it was started. If the listener survives a session switch (e.g., `session_start` fires while listener is already running due to the `if (listenerProcess) return` guard at line 197), voice events dispatch to a stale context whose UI references may be invalid.
- **Impact:** Voice commands after a session-start (where listener was already running) could target a defunct session context, causing silent failures or exceptions in UI calls.
- **Fix:** Change the closure to always prefer `lastCtx`: `handleListenerEvent(event, undefined)` or make the closure reference `lastCtx` directly instead of capturing `ctx`.

### 4. Audio data lost at utterance boundaries (truncated whisper input)
- **Severity:** High
- **File:** `listener/listener.py:76-109`
- **Description:** When the user begins speaking while `active` is true, the first audio chunks may not meet the `ENERGY_THRESHOLD` (300 RMS). Those chunks are fed to Vosk but not appended to `whisper_buffer`. Once energy rises above threshold, `collecting_for_whisper` activates — but the initial chunks containing the start of the utterance are lost. Additionally, when `AcceptWaveform` returns `True` for a non-wake phrase, only the final chunk is appended to the buffer; all preceding chunks that Vosk consumed for that recognition result are lost if `collecting_for_whisper` was not already active.
- **Impact:** The first word or syllable of a user's utterance may be clipped in whisper transcription, causing incorrect or incomplete commands sent to Pi.
- **Fix:** Maintain a small rolling buffer (e.g., last 0.5-1s of audio) that gets prepended to `whisper_buffer` when collection starts, so the onset of speech is preserved.

### 5. readline interface never explicitly closed
- **Severity:** High
- **File:** `index.ts:206-214`
- **Description:** `createInterface({ input: listenerProcess.stdout! })` creates a readline `rl`, but its reference is never stored and `rl.close()` is never called. When `stopListener()` kills the process, the readline may keep emitting events or hold a reference that delays garbage collection. On Windows, killing a process doesn't guarantee immediate stream closure.
- **Impact:** Potential memory leak from unclosed readline interfaces, especially with repeated start/stop cycles. Possible late-arriving events processed after listener is considered stopped.
- **Fix:** Store `rl` as a module-level variable alongside `listenerProcess` and call `rl.close()` in `stopListener()` before killing the process.

### 6. `speakingProcess.on("error")` silently swallows errors
- **Severity:** High
- **File:** `index.ts:173-177`
- **Description:** When `speak11` fails to spawn (e.g., not installed, Python not found), the error handler only does cleanup and resets phase to "ready" — the user gets no notification that speech synthesis failed. They would see the phase jump from "rewrite" back to "ready" with no output.
- **Impact:** Users won't understand why speech isn't working; the failure is completely invisible.
- **Fix:** Add `ctx?.ui?.notify?.("Speech synthesis failed: ...", "error")` in both the `speakingProcess.on("error")` and the non-zero exit code path of `speakingProcess.on("exit")`.

---

## Medium Issues

### 7. Wake phrase is a substring match — false positives
- **Severity:** Medium
- **File:** `listener/listener.py:81-89`
- **Description:** `if WAKE_ON in text` is a substring check. Vosk output like "api mono on", "pi monologue", or "pi mono only" would match. Similarly, "pi mono office" contains "pi mono of" but not "pi mono off" so that's fine — but "pi mono offline" does contain "pi mono off".
- **Impact:** Unintended activation/deactivation from phrases that happen to contain the wake words as substrings.
- **Fix:** Use word-boundary matching: `re.search(r'\bpi mono on\b', text)` instead of `WAKE_ON in text`.

### 8. Full `process.env` passed to listener child process
- **Severity:** Medium
- **File:** `index.ts:204`
- **Description:** `env: { ...process.env }` passes ALL environment variables (including API keys, tokens, secrets) to the Python listener subprocess. The listener only needs `VOSK_MODEL_PATH`, `WHISPER_DEVICE`, `WHISPER_COMPUTE`, `WHISPER_MODEL`, and standard system PATH.
- **Impact:** Unnecessary secret exposure to the child process. If the Python process or its dependencies have vulnerabilities, secrets could be exfiltrated.
- **Fix:** Explicitly pass only the needed env vars: `env: { PATH: process.env.PATH, VOSK_MODEL_PATH: ..., WHISPER_DEVICE: ..., ... }`.

### 9. Session registry: no duplicate name handling
- **Severity:** Medium
- **File:** `index.ts:297-303`
- **Description:** Creating a session with an existing name silently overwrites the old registry entry. The old session still exists but becomes unreachable by name.
- **Impact:** Users can accidentally orphan sessions by reusing names.
- **Fix:** Check if the name exists in `sessionRegistry` and either warn the user or append a suffix.

### 10. `speak` command default case sends raw text as user message
- **Severity:** Medium
- **File:** `index.ts:367-372`
- **Description:** If `/speak <anything>` doesn't match known subcommands (on/off/stop/status/test), the raw text is sent via `pi.sendUserMessage(raw)` AND speech mode is enabled. This means `/speak hello world` enables speech AND sends "hello world" as a user message. This is intentional but undocumented, and could surprise users: `/speak foo` would be treated as a message, not an error.
- **Impact:** Typos in speak subcommands (e.g., `/speak ststus`) silently become user messages to the agent.
- **Fix:** Either document this behavior clearly or add a warning for unrecognized subcommands.

### 11. Python listener has no graceful shutdown mechanism
- **Severity:** Medium
- **File:** `listener/listener.py:155-173`, `index.ts:188-191`
- **Description:** The Node side calls `listenerProcess.kill()` which sends SIGTERM (or `taskkill` on Windows). The Python side relies on `KeyboardInterrupt` catching in the `try/except` block of `main()`. On Windows, `taskkill` terminates the process without raising `KeyboardInterrupt`, so the `finally` block may not execute and the audio stream may not be properly stopped/closed.
- **Impact:** On Windows, the sounddevice audio stream and Vosk/whisper resources may not be cleaned up, potentially locking the microphone.
- **Fix:** Use stdin (currently set to "ignore") as a shutdown signal channel — send a close signal, then `kill` after a timeout. Or use a signal handler in Python.

### 12. Hardcoded Python 3.14 paths
- **Severity:** Medium
- **File:** `index.ts:68-70` (`getSpeakInvocation`), `index.ts:95-100` (`getPython`)
- **Description:** Paths are hardcoded to `Python314` (e.g., `C:/Python314/python.exe`, `AppData/Roaming/Python/Python314/Scripts/speak11.py`). Any other Python version requires fallback to generic `python` on PATH.
- **Impact:** Breaks for users with different Python versions unless `python` is on PATH. Maintenance burden on Python version upgrades.
- **Fix:** Make the Python path configurable via extension settings or environment variable, with fallback to `python3` then `python` on PATH.

---

## Low Issues

### 13. `getSessionsDir()` is defined but never used
- **Severity:** Low
- **File:** `index.ts:283-287`
- **Description:** The function `getSessionsDir()` constructs `~/.pi/sessions` path but is never called anywhere.
- **Impact:** Dead code. No functional impact.
- **Fix:** Remove or integrate it.

### 14. No validation of listener JSON event schema
- **Severity:** Low
- **File:** `index.ts:209-213`
- **Description:** `JSON.parse(line)` succeeds but the result is cast to `ListenerEvent` without validation. If the Python listener emits a malformed event (e.g., `{"type": "speech"}` with no `text` field), `event.text` is undefined. The `if (event.text)` guard in the `speech` case handles this particular case, but other fields aren't validated.
- **Impact:** Potential undefined behavior from malformed events, though current code handles most cases gracefully.
- **Fix:** Add basic schema validation or at minimum check `event.type` is one of the known types.

### 15. Silence timeout in Python uses wall-clock, not audio-clock
- **Severity:** Low
- **File:** `listener/listener.py:68-71, 104-108`
- **Description:** `last_voice_time = time.time()` tracks wall-clock time. If the system is under load (or CPU-throttled), the queue processing may lag behind real-time. The silence timeout would expire based on processing time, not actual audio time.
- **Impact:** Under high CPU load, the silence timeout could fire too early (cutting off speech) or too late (long pauses before transcription triggers).
- **Fix:** Track audio time using sample counts instead of `time.time()`.

### 16. PowerShell player has hardcoded 1200ms tail padding
- **Severity:** Low
- **File:** `index.ts:84`
- **Description:** `Start-Sleep -Milliseconds ($duration + 1200)` adds 1.2 seconds after the calculated audio duration. This is a magic number that may not be appropriate for all audio lengths.
- **Impact:** Short responses have a noticeable delay after playback ends; very long responses might still get cut off if system is slow.
- **Fix:** Make the padding configurable or use a completion event instead of sleep.

### 17. `tsconfig.json` `rootDir` is `.` but only `index.ts` is included
- **Severity:** Low
- **File:** `tsconfig.json`
- **Description:** `rootDir` is set to `.` (project root) but `include` only covers `index.ts`. If any other `.ts` files are added at the root, they'd be compiled. The `listener/` directory is Python-only so it's fine, but it's loose.
- **Impact:** No current impact. Minor hygiene issue.
- **Fix:** Set `rootDir: "."` and keep `include: ["index.ts"]` or tighten to `rootDir: "."`.

---

## Summary

| Severity | Count | Key Findings |
|----------|-------|-------------|
| Critical | 2 | `getExtensionDir()` path bug breaks npm installs; audio queue stalls during transcription |
| High | 4 | Stale ctx in listener closure; audio onset clipping; readline leak; silent speak failures |
| Medium | 6 | False positive wake phrases; env var leakage; no duplicate session names; ungraceful shutdown |
| Low | 5 | Dead code; no event validation; wall-clock silence timeout; magic numbers |

### Top 3 Recommendations

1. **Fix `getExtensionDir()`** — Change to `join(__dirname, "..")` so the listener script is found when installed via npm. This is a ship-blocker.

2. **Move whisper transcription off the main audio loop** — Run `on_speech` in a worker thread so Vosk continues processing audio in real-time during transcription. Without this, the system degrades badly after every voice command.

3. **Fix the stale `ctx` in listener closure** — Make `handleListenerEvent` always use `lastCtx` instead of the captured `ctx` from `startListener`, so voice events target the current session.
