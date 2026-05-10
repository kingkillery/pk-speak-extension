# Phase 1 Plan — Foundation and Product Spine

> Target: Stabilize the Android app spine so Phase 2 (conversation features) and Phase 3 (launch readiness) can build on solid seams.
> 
> Based on actual source audit (`android-app/` as of current HEAD).

---

## Current State (What Already Exists)

The MVP is further along than the original gap analysis assumed. Before planning, here is what is **already working** and should be preserved, not rebuilt:

- **App shell + navigation**: `AppShell.kt` already has adaptive scaffold with `TopAppBar`, bottom `NavigationBar`, side `NavigationRail` (840dp breakpoint), and destination routing (Conversation ↔ Settings).
- **Theme system**: `ThemePreferences.kt` already persists System/Light/Dark and exposes `StateFlow<ThemeMode>`. `AppViewModel.kt` holds theme state for the shell.
- **Settings screen**: `SettingsScreen.kt` (582 lines) is already a real destination with connection mode, machine profile CRUD, base URL/token fields, routing target chips, appearance toggle, audio switches, and diagnostics log.
- **Network security config**: `network_security_config.xml` exists with cleartext whitelist for Tailscale/LAN/Bluetooth/localhost.
- **Encrypted storage**: `SecureSettingsStore.kt` handles settings, history (max 25), diagnostics (max 30), and machine profiles with deduplication + redaction.
- **Build variants**: `debug`, `staging`, `release` are configured.
- **Tests**: DTO mapping, theme enum, settings validation, privacy redaction, URL resolution, and UI state defaults all have passing tests.
- **Hilt DI**: Clean dependency graph; no rework needed.

**The actual remaining problems:**
1. `MainScreen.kt` is **1,327 lines** with ~15 private composables — monolithic.
2. `MainViewModel.kt` is **824 lines** — god ViewModel mixing connection, turn, audio, and diagnostics.
3. `MainUiState.kt` is a **single flat data class** (~25 fields) — no named feature states.
4. `MainViewModel` imports `PiSpeakRepositoryImpl.resolveAudioUrl` directly — **layer leakage**.
5. `Models.kt` contains **hardcoded Tailscale/LAN/Bluetooth IPs** — should live in `BuildConfig`.
6. **No instrumentation tests** and no ViewModel/repository unit tests beyond DTOs.

---

## Goals

1. **Feature-boundary UI**: Extract `MainScreen.kt` into scoped packages so no single file exceeds ~250 lines.
2. **Focused ViewModels**: Split `MainViewModel` into `ConnectionViewModel`, `TurnViewModel`, and `AudioViewModel` with clean, explicit contracts.
3. **Explicit state models**: Replace the flat `MainUiState` with named, smaller state classes owned by their ViewModels.
4. **Fix layer leakage**: Ensure presentation depends only on domain interfaces and use cases, never on `*Impl` classes.
5. **Config hygiene**: Move hardcoded IPs from domain models into `BuildConfig` fields per build type.
6. **Foundational tests**: Add unit tests for the new ViewModels and state contracts before Phase 2 touches them.

---

## Task Breakdown

### Task 1 — Decompose `MainUiState` into Explicit Feature States

**Why now**: The UI split and ViewModel split both depend on knowing what state belongs to whom. State decomposition is the contract that drives everything else.

**New files to create:**

```
presentation/connection/
  ConnectionUiState.kt          // machine profiles, connection status, validation
  ConnectionUiStateTest.kt

presentation/turn/
  TurnUiState.kt                // composer (text/voice), submission phases, history
  TurnUiStateTest.kt

presentation/audio/
  AudioUiState.kt               // playback state, autoplay prefs, continuous mode
  AudioUiStateTest.kt

presentation/diagnostics/
  DiagnosticsUiState.kt         // recent events, error details
  DiagnosticsUiStateTest.kt
```

**What moves where from current `MainUiState`:**

| Current Field | New Owner |
|---------------|-----------|
| `machineProfiles`, `selectedMachine`, `connectionState`, `connectionError` | `ConnectionUiState` |
| `composerText`, `turnPhase`, `latestTranscript`, `latestReply`, `recentTurns`, `sendError` | `TurnUiState` |
| `playbackState`, `currentAudioUrl`, `autoplayEnabled`, `continuousConversation` | `AudioUiState` |
| `diagnostics`, `lastDiagnosticEvent` | `DiagnosticsUiState` |

**Validation**: `MainUiState.kt` is deleted. No single state class has more than 12 fields. Each state class has a `Test.kt` verifying default idle values and enum coverage.

---

### Task 2 — Fix Repository Layer Leakage

**Problem**: `MainViewModel.kt:8` imports `PiSpeakRepositoryImpl.resolveAudioUrl`.

**Fix**:
1. Move `resolveAudioUrl` logic entirely into the existing `ResolveAudioUrlUseCase`.
2. Expose a domain interface method if the ViewModel needs URL resolution for playback.
3. Remove all `*Impl` imports from `presentation/`.

**Files to touch**:
- `domain/usecase/ResolveAudioUrlUseCase.kt` — absorb the impl helper logic.
- `domain/repo/PiSpeakRepository.kt` — add `resolveAudioUrl(baseUrl: String, audioUrl: String): String` to the interface if needed.
- `data/repo/PiSpeakRepositoryImpl.kt` — implement the interface method.
- `presentation/main/MainViewModel.kt` — replace direct `PiSpeakRepositoryImpl` import with use case or interface call.

**Validation**: `grep -r "RepositoryImpl" presentation/` returns zero matches.

---

### Task 3 — Move Hardcoded IPs to BuildConfig

**Problem**: `domain/model/Models.kt` contains `TAILSCALE_APPSERVER_IP`, `LAN_MSI_IP`, etc. These are environment-specific, not domain constants.

**Fix**:
1. In `app/build.gradle.kts`, add `buildConfigField` entries per build type for the default IPs.
   ```kotlin
   buildConfigField("String", "TAILSCALE_APPSERVER_IP", '"100.76.136.91"')
   buildConfigField("String", "LAN_MSI_IP", '"192.168.1.100"')
   buildConfigField("String", "BLUETOOTH_BASE_URL", '"http://192.168.44.1:8767/"')
   ```
2. Update `domain/model/Models.kt` to read from `BuildConfig` instead of hardcoded strings.
3. Keep the `MachineProfile` defaults but source their IP values from `BuildConfig`.

**Validation**: `grep -r "100\.76\." domain/` returns zero matches. `./gradlew.bat test` still passes.

---

### Task 4 — Split `MainViewModel` into Focused ViewModels

**Why now**: Once state contracts are clean (Task 1) and layer leakage is fixed (Task 2), the ViewModel split is mechanical.

**New files to create:**

```
presentation/connection/
  ConnectionViewModel.kt        // machine profile selection, status polling, validation
  ConnectionViewModelTest.kt

presentation/turn/
  TurnViewModel.kt              // text/voice composition, send, history append
  TurnViewModelTest.kt

presentation/audio/
  AudioViewModel.kt             // playback control, autoplay, continuous rearm
  AudioViewModelTest.kt

presentation/diagnostics/
  DiagnosticsViewModel.kt       // event collection, export/clear
  DiagnosticsViewModelTest.kt
```

**Responsibility map:**

| Concern | Current Location | New Location |
|---------|-----------------|--------------|
| Machine profile selection | `MainViewModel` | `ConnectionViewModel` |
| Status polling / validation | `MainViewModel` | `ConnectionViewModel` |
| Route target changes | `MainViewModel` | `ConnectionViewModel` |
| Text/voice composition | `MainViewModel` | `TurnViewModel` |
| Send turn + history append | `MainViewModel` | `TurnViewModel` |
| Recording lifecycle (start/stop) | `MainViewModel` | `TurnViewModel` |
| Audio playback start/stop | `MainViewModel` | `AudioViewModel` |
| Autoplay + continuous mode | `MainViewModel` | `AudioViewModel` |
| Diagnostics logging | `MainViewModel` | `DiagnosticsViewModel` |
| Deep-link bootstrap | `MainViewModel.applyBootstrap()` | `ConnectionViewModel.applyBootstrap()` |

**Bootstrap wiring**: `MainActivity` currently passes deep-link params into `MainViewModel`. After the split, it should pass base URL / token / machine ID into `ConnectionViewModel`.

**Validation**: Each new ViewModel is under 250 lines. `MainViewModel.kt` is deleted. `./gradlew.bat test` passes.

---

### Task 5 — Extract `MainScreen.kt` into Feature-Scoped Composables

**Why now**: The ViewModels and state are now scoped, so the UI can follow the same boundaries.

**New files to create:**

```
presentation/connection/
  ConnectionPanel.kt            // machine picker, connection status, quick setup
  ConnectionPanelTest.kt (optional for now)

presentation/turn/
  TurnComposer.kt               // text field + send button
  VoiceOrb.kt                   // push-to-talk control with 5 states
  TurnHistoryList.kt            // recent turns scrollable list
  TurnCard.kt                   // single turn card (transcript, reply, retry)

presentation/audio/
  PlaybackControl.kt            // play/stop/loading/failed states per turn

presentation/diagnostics/
  DiagnosticsPanel.kt           // event log, error details (moved from Settings)
  ErrorBanner.kt                // top-level error snackbar/banner host
```

**What happens to `MainScreen.kt`:**
- It becomes a thin `ConversationScreen.kt` (~100–150 lines) that collects from `ConnectionViewModel`, `TurnViewModel`, and `AudioViewModel` and delegates to the extracted composables.
- The existing `SettingsScreen.kt` remains largely unchanged; it may import `ConnectionPanel` or `DiagnosticsPanel` if shared.

**Validation**: No file in `presentation/` exceeds 300 lines (except `SettingsScreen.kt` which we leave for Phase 2). `./gradlew.bat test` passes.

---

### Task 6 — Add Foundational Unit Tests for New Contracts

**Tests to add:**

| Test File | What It Proves |
|-----------|---------------|
| `ConnectionViewModelTest.kt` | Profile selection changes state; bootstrap applies URL/token; invalid URL produces validation error |
| `TurnViewModelTest.kt` | Text send advances through phases; history appends; voice file path is tracked |
| `AudioViewModelTest.kt` | Play request updates playback state; autoplay toggle persists; stop resets state |
| `DiagnosticsViewModelTest.kt` | Events append up to max; clear empties list |
| `ConnectionUiStateTest.kt` | Default idle values; enum coverage |
| `TurnUiStateTest.kt` | Default idle values; send-phase transitions are valid |
| `AudioUiStateTest.kt` | Default idle values; playback state machine coverage |

**Tools**: JUnit 4 + Turbine (add `testImplementation("app.cash.turbine:turbine:1.1.0")` to `build.gradle.kts` for `StateFlow` testing).

**Validation**: `./gradlew.bat test` passes with ≥20 new unit tests.

---

## Sequencing & Dependencies

```
Task 1 (State decomposition)
    ↓
Task 2 (Fix leakage) ──→ Task 3 (BuildConfig IPs)
    ↓                       ↓
Task 4 (Split ViewModels) ←┘
    ↓
Task 5 (Extract UI)
    ↓
Task 6 (Add tests)
```

**Why this order:**
- State must be defined before ViewModels can own it.
- Layer leakage must be fixed before ViewModels are duplicated, or the leak multiplies.
- BuildConfig hygiene is independent but should land before ViewModels reference the new config.
- UI extraction is easiest when the ViewModels are already scoped.
- Tests lock the new contracts; writing them last means they validate the final shape.

---

## Files to Create

```
android-app/app/src/main/java/com/pkkidking/pispeak/presentation/
  connection/
    ConnectionUiState.kt
    ConnectionViewModel.kt
    ConnectionPanel.kt
  turn/
    TurnUiState.kt
    TurnViewModel.kt
    TurnComposer.kt
    VoiceOrb.kt
    TurnHistoryList.kt
    TurnCard.kt
  audio/
    AudioUiState.kt
    AudioViewModel.kt
    PlaybackControl.kt
  diagnostics/
    DiagnosticsUiState.kt
    DiagnosticsViewModel.kt
    DiagnosticsPanel.kt
    ErrorBanner.kt

android-app/app/src/test/java/com/pkkidking/pispeak/presentation/
  connection/
    ConnectionUiStateTest.kt
    ConnectionViewModelTest.kt
  turn/
    TurnUiStateTest.kt
    TurnViewModelTest.kt
  audio/
    AudioUiStateTest.kt
    AudioViewModelTest.kt
  diagnostics/
    DiagnosticsUiStateTest.kt
    DiagnosticsViewModelTest.kt
```

## Files to Modify

```
android-app/app/build.gradle.kts                // BuildConfig fields, Turbine dep
data/repo/PiSpeakRepositoryImpl.kt              // resolveAudioUrl interface impl
domain/repo/PiSpeakRepository.kt                // resolveAudioUrl interface method
domain/usecase/ResolveAudioUrlUseCase.kt        // absorb impl logic
domain/model/Models.kt                          // read IPs from BuildConfig
presentation/main/MainScreen.kt                 // thin into ConversationScreen
presentation/main/MainUiState.kt                // delete after migration
presentation/main/MainViewModel.kt              // delete after migration
MainActivity.kt                                 // bootstrap → ConnectionViewModel
```

## Files to Preserve (No Changes)

```
PiSpeakApplication.kt
core/AppModule.kt
core/AppAudioPlayer.kt
core/AppAudioRecorder.kt
data/api/PiSpeakApiService.kt
data/model/RemoteDtos.kt
data/storage/SecureSettingsStore.kt
data/storage/ThemePreferences.kt
domain/model/PrivacyRedactor.kt
domain/usecase/RemoteUseCases.kt
presentation/app/AppShell.kt
presentation/app/AppViewModel.kt
presentation/settings/SettingsScreen.kt
ui/theme/Theme.kt
```

---

## Acceptance Criteria

- [ ] `MainUiState.kt` and `MainViewModel.kt` are deleted.
- [ ] `grep -r "RepositoryImpl" presentation/` returns zero matches.
- [ ] `grep -r "100\.76\." domain/` returns zero matches.
- [ ] No file in `presentation/` (except `SettingsScreen.kt`) exceeds 300 lines.
- [ ] `./gradlew.bat test` passes with all existing tests plus ≥20 new tests.
- [ ] App still launches, connects, sends text turns, sends voice turns, and plays replies (manual smoke test).
- [ ] Deep-link setup (`pi-speak://setup`) still applies profile correctly.
- [ ] Theme toggle (System/Light/Dark) still works across process death.

---

## Risk & Mitigation

| Risk | Mitigation |
|------|------------|
| Refactor breaks recording/playback lifecycle | Keep `AppAudioRecorder` and `AppAudioPlayer` untouched; only the ViewModel that calls them changes. |
| State split introduces desync between Connection and Turn | Use explicit events (not shared mutable state) for cross-VM communication; keep Hilt-scoped ViewModels at the screen level so they share the same lifecycle. |
| SettingsScreen still holds diagnostics UI | Acceptable for Phase 1; `DiagnosticsPanel.kt` can be reused in Settings later. |
| Test count grows but coverage is shallow | Focus tests on state transitions and VM public API, not Android framework internals. |

---

## Next Step

Start with **Task 1** (state decomposition) and proceed sequentially. Ready to begin implementation.
