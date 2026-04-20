# Autopilot Spec - android-foundation-phase1

## Scope
Execute the first production-foundation slice for the Pi Speak Android app without changing the underlying remote feature set.

## Requirements
- Add a real app shell that separates the conversation surface from settings.
- Add persistent theme appearance controls with System, Light, and Dark options.
- Preserve text turn, voice turn, status refresh, route targeting, and reply playback behavior.
- Remove direct presentation-layer dependence on `PiSpeakRepositoryImpl` for audio URL resolution.
- Keep the result compatible with Android 10 through Android 15.
- Keep the change set small enough to validate with the existing Android test/build loop.

## Technical notes
- Prefer a thin app-level shell composable rather than introducing a heavy multi-graph navigation system.
- Reuse the existing `MainViewModel` for current remote interaction state while introducing a dedicated app-level theme ViewModel.
- Theme persistence should use ordinary `SharedPreferences`, not encrypted storage.
- Add a small pure test surface for new non-UI logic.
