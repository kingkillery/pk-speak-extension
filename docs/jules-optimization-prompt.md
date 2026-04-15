Fix and optimize `kingkillery/pi-speak-extension` on the `main` branch.

Create a single PR that implements these 5 improvements together, with tests and docs updates where appropriate.

## Goals

1. Fix npm-installed listener path resolution.
2. Prevent wake-word audio processing from stalling during Whisper transcription.
3. Harden listener lifecycle and session-context handling.
4. Improve speech capture accuracy and wake-phrase robustness.
5. Make session routing and in-flight voice behavior safer and more predictable.

## Optimization 1: Fix installed listener path resolution

Problem:
- The extension can fail to find `listener/listener.py` after npm install because runtime path resolution is fragile.

Required changes:
- Audit `getExtensionDir()` and all listener/script path resolution in `index.ts`.
- Ensure the extension works when loaded from `dist/index.js` inside `node_modules/pi-speak-pk/`.
- Add a regression test or other deterministic verification for packaged-path resolution.

Key files:
- `index.ts`
- `listener/listener.py`
- `package.json`
- any build/test helper you add

## Optimization 2: Stop transcription from blocking real-time listener processing

Problem:
- The current listener flow can fall behind real-time audio when Whisper transcription is running, which hurts wake-word reliability and causes stale audio handling.

Required changes:
- Refactor `listener/listener.py` so wake-word detection stays responsive while transcription work happens off the hot audio loop.
- Add bounded backpressure for queued transcription work.
- Avoid unbounded memory growth for buffered speech segments.
- Preserve current behavior for the `pi mono` interaction model.

Key files:
- `listener/listener.py`
- `index.ts`

## Optimization 3: Harden listener lifecycle and current-session routing

Problem:
- Listener events can be tied to stale session context, and listener/readline cleanup is brittle across restarts and session switches.

Required changes:
- Ensure listener events always route through the current active session context rather than a stale captured context.
- Explicitly manage the readline lifecycle in Node.
- Improve listener shutdown/restart behavior so session switches and crashes recover cleanly.
- Keep `/mono on`, `/mono off`, and session switching behavior predictable.

Key files:
- `index.ts`
- `listener/listener.py`

## Optimization 4: Improve wake-phrase precision and speech-onset capture

Problem:
- Wake detection is too permissive, and speech transcription can clip the beginning of the utterance.

Required changes:
- Replace substring-based wake matching with safer word-boundary matching.
- Add a short rolling pre-buffer so speech onset is preserved when collection begins.
- Keep false positives and clipped first words from reaching Pi.
- Add targeted tests or fixtures for wake matching and onset buffering logic where practical.

Key files:
- `listener/listener.py`
- tests you add

## Optimization 5: Make session registry and in-flight voice behavior safer

Problem:
- Named session registry durability is weak across restarts, duplicate names can silently overwrite prior mappings, and voice turns can be sent while an agent is already streaming.

Required changes:
- Improve persistence for named-session registry so it survives restarts more reliably.
- Prevent silent overwrite of duplicate session names.
- Add a guard or explicit policy for what happens when a new voice turn arrives while an agent is already producing a response.
- Prefer deterministic behavior over framework-dependent side effects.

Key files:
- `index.ts`
- any state persistence helpers you add

## Tests

Add or expand tests for:
- packaged listener path resolution
- session registry duplicate-name handling
- listener shutdown/restart behavior where testable
- any new pure logic extracted for wake-word matching or queue/backpressure behavior

Keep all existing tests passing.

## Constraints

- Do not introduce unnecessary new dependencies.
- Preserve existing public commands and user-facing flows unless a behavior change is clearly safer and documented.
- Keep the PR reviewable: focused changes, comments only where they materially clarify tricky logic.
- Update `README.md` if operational behavior changes.

## Deliverable

- One PR with implementation, tests, and a concise summary of the five completed optimizations.
