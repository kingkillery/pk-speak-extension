# Autopilot Implementation Plan - android-foundation-phase1

## Phase 1 - App shell
- Introduce an app shell composable with explicit destinations for Conversation and Settings.
- Update `MainActivity` to host the shell and apply theme mode from app state.

## Phase 2 - Settings and theme preferences
- Add persistent theme preferences with System, Light, and Dark modes.
- Move connection and audio toggles into a dedicated settings surface.

## Phase 3 - Boundary cleanup and validation
- Extract audio URL resolution from the concrete repository implementation into a dedicated use case.
- Add tests for the new pure logic and rerun Android tests.
