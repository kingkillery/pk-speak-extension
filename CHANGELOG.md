# Changelog

## Unreleased

Ongoing listener, remote-UX, and skill-aware speech-mode work.

Added:

- `/sess ui` opens the interactive Ink-based session manager pane in a separate terminal (detached from pi-coding-agent), rendering the live dashboard with `[r] rename`, `[a] alias`, `[x] remove`, `[q] quit` keybindings and surfacing voice/admin mutations as 3-second toasts
- an append-only voice/admin session-event log (`session-events.jsonl`) that the management pane tails, plus an extension-side routing-store watcher that reloads in-process session state when the pane writes externally
- `/sess` default manager view that shows current session, ready sessions, aliases, saved store path, and inline `busy` / `idle` / `saved` state
- explicit session-manager actions for `/sess rename`, `/sess alias add`, `/sess alias remove`, and confirmed `/sess remove`
- `/sess edit <session>` as a convenience wrapper that shows per-session shortcuts and can proxy common follow-up actions
- `docs/SESSION_MANAGER_SPEC.qmd` as the design note for the session-manager abstraction
- configurable local wake phrase with `PK` as the new default via `PI_SPEAK_WAKE_PHRASE`
- wake-alias routing so `/sess wake <alias>` can map phrases like `PK one` or `PK to Google` to different sessions
- deterministic compact routing families so `PK one` / `PK 1` / `PK1` stay together, `PK two` / `PK 2` / `PK2` stay together, and the `1` family stays distinct from the `2` family
- `/sess slots` as an explicit compact-lane inspection view for the PK1/PK2 session lanes
- a lightweight local attention broker plus `/attn` commands so Pi windows on the same machine can share ready-for-attention state
- skill-aware speech prompt routing so spoken and typed turns can proactively load matching installed skills by name, alias, trigger phrase, start word, related command, or clear intent
- a voice-command bridge that converts spoken skill-routing phrases into explicit internal requests, so voice input can steer into a named skill or ask Pi to choose the best matching skill before acting
- `PI_SPEAK_WAKE_SENSITIVITY=low|medium|high` as the main wake-activation sensitivity toggle, plus lower-level fuzzy and compact-prefix env overrides when needed
- auto TTS provider fallback so a failing `legacy/speak11` attempt can fall through to the next available provider instead of aborting speech outright
- a deterministic, offline `sanitizeForSpeech` pass (toggle via `PI_SPEAK_SANITIZE`, default on, exposed in `getTtsDiagnostics`) that runs at the shared synthesis chokepoint for every non-legacy provider, so text from any agent runtime (pi, codex, oh-my-pi, claude code) gets markdown, code fences, links, and emoji stripped before TTS even when the optional LLM rewrite is disabled or unavailable

Improved:

- remote execution routing now honors explicit `AGENT_PROVIDER=pi|codex` when `PI_SPEAK_EXECUTION_ROUTER_MODE` is unset, while keeping `PI_SPEAK_EXECUTION_ROUTER_MODE=auto|pi|codex` as the higher-priority router override
- the `pi-speak-admin` CLI now runs the real Ink session-manager app instead of a placeholder stub, seeds current-session context from the launching Pi window, supports keyboard focus movement plus inline rename/alias/remove prompts, shows compact PK1/PK2 route lanes and a focused-session footer, exposes `--snapshot` for deterministic Ink-frame rendering in tests and automation, and falls back to a read-only snapshot when launched without a live TTY
- local Python/audio portability now honors `PI_SPEAK_PYTHON` and `PI_SPEAK_SPEAK11_PATH` first, scans user-site `Python*/Scripts` locations instead of pinning to `Python314`, and keeps safer fallbacks for PATH-based setups
- listener shutdown now sends an explicit stdin `shutdown` command before ending stdin, while keeping a timed force-kill fallback so local audio resources are more likely to close cleanly on Windows
- package publishing now builds both the core extension and the UI bundle before release so the shipped `pi-speak-admin` binary stays in sync
- operator guidance now uses a bridge-first documentation flow with `/sess` positioned as the main session-manager interface and `/attn` positioned as the advanced/debug broker surface
- remote/mobile operator docs now include a dedicated live validation run sheet at `docs/REMOTE_VALIDATION_CHECKLIST.md` so phone-path QA can be executed and recorded consistently
- remote/mobile validation docs now also include `docs/REMOTE_VALIDATION_RUN_SHEET.md` as a compact pass/fail worksheet for live phone sessions
- voice session-control phrases like `show sessions`, `current session`, `remove session bugfix`, and `what's ready` now prefer the `/sess` manager surface
- `/sess` argument completions are now context-aware and can suggest session-specific edit and alias-removal shortcuts
- operator guidance now uses a bridge-first documentation flow with a dedicated session-operations guide for `/sess`, `/attn`, wake aliases, and natural voice routing
- named session routing and wake aliases now persist across extension restarts via a shared local store
- `/sess` now rejects duplicate names, cleans up stale rename mappings for the current session, exposes `/sess export` for store-path diagnostics, blocks conflicting `one/1` vs `two/2` route-family collisions, and shows the compact-lane summary inline in the default dashboard
- voice session control now understands spoken `/sess` and `/attn` phrases like creating, switching, naming, aliasing, listing, exporting, and checking ready sessions
- local mono playback can now be interrupted by spoken stop phrases like `stop` and `stop speaking`
- one local window can now act as the attention watcher and announce newly ready sessions from other Pi windows
- replaced Vosk wake detection with a free offline `faster-whisper` tiny wake-detection path
- mono listener copy and docs now reference the new `PK` wake phrase flow, including deterministic short routes and the rule that multi-word names like `to Google` stay literal instead of collapsing into the `2` family
- listener Python requirements no longer depend on `vosk`
- listener and local STT worker env handling now ignore blank whisper config values, so an empty `WHISPER_MODEL` no longer crashes transcription
- listener child-process env forwarding now includes wake-sensitivity controls so the Python listener actually sees `PI_SPEAK_WAKE_SENSITIVITY` and related overrides
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
