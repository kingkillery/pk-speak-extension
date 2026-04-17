# Autopilot Spec — speak-extension-hardening

## Scope
Deliver the next two production-hardening improvements for `pi-speak-pk`:
1. Make `pi-speak-admin` degrade safely outside a live TTY.
2. Replace brittle Python 3.14 assumptions with configurable, testable path discovery for local Python/speak11 integration.

## Requirements
- `pi-speak-admin --help` must remain fast and deterministic.
- Plain `pi-speak-admin` in a non-interactive environment must not crash with Ink raw-mode errors.
- Non-interactive fallback should give a useful read-only rendering of the session pane.
- `PI_SPEAK_PYTHON` must be honored when set.
- `PI_SPEAK_SPEAK11_PATH` must be honored when set.
- Default discovery should search realistic user-site locations without pinning to `Python314` only.
- Existing behavior should remain compatible when no env vars are set.
- Add automated tests for both hardening areas.

## Technical notes
- Prefer a small root-level helper module for Python/speak11 discovery so logic can be unit-tested independently of `index.ts`.
- For non-TTY admin CLI invocations, use the existing snapshot renderer instead of trying to run a reduced Ink session.
- Keep release/docs synchronized if user-facing behavior changes.
