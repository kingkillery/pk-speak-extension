# Autopilot Implementation Plan — speak-extension-hardening

## Phase 1 — Admin CLI robustness
- Detect non-interactive stdin/stdout before launching the live Ink loop.
- Fall back to snapshot output with a short explanatory line.
- Add CLI regression test covering non-TTY invocation without `--snapshot`.

## Phase 2 — Python/speak11 discovery hardening
- Extract pure helper(s) for:
  - Python command resolution
  - speak11 path resolution
  - user-site script scanning
- Honor `PI_SPEAK_PYTHON` and `PI_SPEAK_SPEAK11_PATH` first.
- Replace Python314-only lookup with scanned `AppData/Roaming/Python/Python*/Scripts` candidates.
- Keep safe fallbacks to `python3` / `python` and PATH `speak11`.
- Add unit tests for the helper module.

## Phase 3 — Validation
- Re-run full test suite.
- Update docs/changelog for fallback and env-backed portability behavior.
