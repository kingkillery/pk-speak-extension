# Changelog

## Unreleased

Ongoing listener, remote-UX, and skill-aware speech-mode work.

Added:

- `/sess` default manager view that shows current session, ready sessions, aliases, saved store path, and inline `busy` / `idle` / `saved` state
- explicit session-manager actions for `/sess rename`, `/sess alias add`, `/sess alias remove`, and confirmed `/sess remove`
- `/sess edit <session>` as a convenience wrapper that shows per-session shortcuts and can proxy common follow-up actions
- `docs/SESSION_MANAGER_SPEC.qmd` as the design note for the session-manager abstraction
- configurable local wake phrase with `PK` as the new default via `PI_SPEAK_WAKE_PHRASE`
- wake-alias routing so `/sess wake <alias>` can map phrases like `PK one` or `PK to Google` to different sessions
- a lightweight local attention broker plus `/attn` commands so Pi windows on the same machine can share ready-for-attention state
- skill-aware speech prompt routing so spoken and typed turns can proactively load matching installed skills by name, alias, trigger phrase, start word, related command, or clear intent
- a voice-command bridge that converts spoken skill-routing phrases into explicit internal requests, so voice input can steer into a named skill or ask Pi to choose the best matching skill before acting

Improved:

- operator guidance now uses a bridge-first documentation flow with `/sess` positioned as the main session-manager interface and `/attn` positioned as the advanced/debug broker surface
- voice session-control phrases like `show sessions`, `current session`, `remove session bugfix`, and `what's ready` now prefer the `/sess` manager surface
- `/sess` argument completions are now context-aware and can suggest session-specific edit and alias-removal shortcuts
- operator guidance now uses a bridge-first documentation flow with a dedicated session-operations guide for `/sess`, `/attn`, wake aliases, and natural voice routing
- named session routing and wake aliases now persist across extension restarts via a shared local store
- `/sess` now rejects duplicate names, cleans up stale rename mappings for the current session, and exposes `/sess export` for store-path diagnostics
- voice session control now understands spoken `/sess` and `/attn` phrases like creating, switching, naming, aliasing, listing, exporting, and checking ready sessions
- local mono playback can now be interrupted by spoken stop phrases like `stop` and `stop speaking`
- one local window can now act as the attention watcher and announce newly ready sessions from other Pi windows
- replaced Vosk wake detection with a free offline `faster-whisper` tiny wake-detection path
- mono listener copy and docs now reference the new `PK` wake phrase flow
- listener Python requirements no longer depend on `vosk`
- listener and local STT worker env handling now ignore blank whisper config values, so an empty `WHISPER_MODEL` no longer crashes transcription
- the injected CodeChat speech prompt now prefers relevant skill files, rewrites rough requests into a clearer internal working prompt, and nudges prompt or skill-improvement tasks toward the appropriate improvement workflows
- the mono voice path now recognizes explicit spoken skill-bridge phrases like using a named skill or asking for the right skill, and forwards them as stronger structured prompts instead of raw transcript text

## 0.2.1

Listener reliability and activation-cue release.

Added:

- authenticated `/v1/diagnostics`
- in-memory remote turn queue with deterministic busy/backpressure behavior
- warm local STT worker process for remote voice uploads
- Telegram polling diagnostics and error tracking
- automated tests for HTTP auth/limits, queue behavior, Telegram link flow, and PWA token persistence
- Android native companion app scaffold with secure settings storage, route control, text turns, voice turns, and reply audio playback
- local mono activation cues with stronger `mono:listening` status output

Improved:

- remote auth now prefers header-based tokens for control and turn routes
- reply-audio fetch path now uses auth headers instead of query-token fallback by default
- PWA token handling now defaults to session-only storage with an explicit remember-device option
- remote request limits, rate limits, content-type validation, and timeout handling
- background cleanup for reply-audio artifacts
- listener child-process env scoping and listener event validation
- listener Vosk model resolution and cache fallback on Windows
- listener overflow handling now degrades gracefully with bounded queues and higher-latency capture defaults
- operator documentation for production remote use

## 0.2.0

Major upgrade from the original single-path speech extension to a broader voice and remote-control package.

Added:

- multi-provider TTS with `legacy`, `edge`, `openai`, `elevenlabs`, and `auto`
- optional rewrite-for-speech before synthesis
- Telegram phone bridge for text and voice-note turns
- remote STT with local `faster-whisper` or OpenAI
- built-in HTTP control server
- built-in mobile web app at `/app/`
- Unified Remote custom remote bundle
- better persisted runtime state for speak, mono, phone, and remote modes
- configurable `pi mono` keep-alive timeout

Improved:

- local and remote documentation
- security behavior for HTTP auth bypass
- audio artifact handling for remote replies

## 0.1.0

Initial published package.
