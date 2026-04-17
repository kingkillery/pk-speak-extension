# Autopilot Context Snapshot

- Task statement
  - Harden `pi-speak-pk` in the highest-value remaining areas identified during repo review.

- Desired outcome
  - Improve runtime robustness for the Ink admin pane outside true TTYs.
  - Remove brittle Python 3.14 assumptions from local voice/TTS path discovery.
  - Preserve current behavior where possible and keep the repo test-green.

- Known facts/evidence
  - `ui/admin.tsx` currently renders Ink with `interactive: true` unconditionally.
  - Non-TTY invocation of `node dist/ui/admin.js` currently fails with Ink raw-mode errors.
  - `index.ts` still hardcodes `C:/Python314/python.exe` and `AppData/Roaming/Python/Python314/Scripts/speak11.*` assumptions.
  - `README.md` already documents `PI_SPEAK_PYTHON` and `PI_SPEAK_SPEAK11_PATH`, but the code paths do not fully honor them.
  - Listener shutdown over stdin is already implemented; this is lower priority than TTY fallback and Python portability.

- Constraints
  - Keep changes low-risk and reversible.
  - Do not disturb already-passing session-manager behavior.
  - Prefer pure helpers plus tests over ad hoc logic.
  - Maintain Windows-first behavior while improving portability.

- Unknowns/open questions
  - Whether operators want snapshot fallback text printed silently or with an explanatory banner.
  - Whether any existing workflows depend on the exact old Python resolution order.

- Likely codebase touchpoints
  - `ui/admin.tsx`
  - `index.ts`
  - `README.md`
  - `CHANGELOG.md`
  - `tests/ui-admin-cli.test.mjs`
  - new runtime path helper + tests
