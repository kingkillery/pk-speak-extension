# StudioComposables.kt structure (extracted from MainActivity.kt)

Source: `android-app/app/src/main/java/com/example/StudioComposables.kt` (new file, untracked as of 2026-07-02), extracted from `MainActivity.kt` during the Android redesign (diff: MainActivity.kt -1746/+~600 net, i.e. -1151 lines).

## Purpose
Pulls the Studio tab's cockpit composables out of the monolithic `MainActivity.kt` into a dedicated file, matching the `StudioTabContent` component named in `DESIGN.md`.

## Composable tree (top to bottom, `StudioComposables.kt`)
- `StudioCockpitLayout` (public, `@OptIn(ExperimentalPermissionsApi)`) — top-level entry; takes `StudioRuntimeState`, `AppPreferences`, list/permission/session state, and turn/record/send callbacks.
  - `StudioStatusStrip(state, onClearConversation)` — private.
  - `StudioConversationPanel(...)` — private; hosts the scrollable log.
    - `ConversationLogHeader(onClearConversation, enabled)`
    - `StudioChatMessage(message, activeAgent, playingMessageId, ...)` — per-message row.
      - `MessageActions(message, isPlaying, ...)` — play/replay controls.
    - `TranscriptStream(text)` — live partial-transcript display.
    - `TurnProgress(progressText, showTurnProgress, stopStatusText, onStopCurrentTurn)`
    - `StudioIdleState(transmissionMode, targetSession, gatewayStatus, modifier)` — **new empty state** shown when there's no conversation yet; replaces whatever blank/placeholder state existed before the redesign.
      - `IdleHintRow(label, value)` — key/value hint rows inside the idle state.
  - `StudioComposer(...)` (`@OptIn(ExperimentalPermissionsApi)`, private) — input row: text field + record/send controls.
    - `StudioComposerActions(...)` — button cluster (live session start/stop, record trigger, stop-and-send, send text).
      - `StudioPillButton(text, textColor, backgroundColor, onClick)` — shared pill-shaped action button.

## Notable new concept: `StudioIdleState`
Empty-state composable satisfying the DESIGN.md interaction rule "Empty states should tell the operator what to do next" — shows transmission mode, target session, and gateway status as hint rows via `IdleHintRow` instead of a blank panel.

## Relationship to MainActivity.kt
`MainActivity.kt` shrank from a much larger single file (net -1151 lines in this diff) by delegating Studio-tab rendering to this file. `HeaderConnectionStateTest.kt` received a small follow-up diff (+3/-3), suggesting a minor rename/signature touch-up tied to the `HeaderSection` rework rather than a full behavior change — worth a quick confirm read before merge.

## Status
Structure captured 2026-07-02 while `MainActivity.kt`/`StudioComposables.kt` changes are still uncommitted (git status: `M` MainActivity.kt, `??` StudioComposables.kt). Re-check after the redesign lands to confirm the tree above still matches and update this page rather than leaving it stale.

## Update (pass 3, 2026-07-02) — extraction pattern generalized
The `MainActivity.kt` split is not limited to Studio. By pass 3, `MainActivity.kt` dropped from ~4941 to 2245 lines as two more tab-composable files appeared:
- `SessionsComposables.kt` (~1776 lines) — `SessionsTabContent` (public entry) with a pane toggle (`SessionsPaneToggle`: "Hub" / "Ops" / "History") switching between `GatewaySessionsPane`, `GatewayOpsPane`, and `LocalTurnHistoryPane`. `GatewaySessionsPane` owns hub launch (OMPK), Colab launch, and collab-join flows plus a `GatewaySessionsHeader`.
- `SettingsComposables.kt` (~1097 lines) — `SettingsTabContent` (public entry, `@OptIn(ExperimentalMaterial3Api)`) plus a `WorkspaceFileViewerDialog` and `formatWorkspaceFileSize` helper.

Pattern: each major tab (`Studio`, `Sessions`, `Settings`) is being pulled into its own `<Tab>Composables.kt` file with a public `<Tab>TabContent` entry point, private helper composables below it. `MainActivity.kt` is trending toward a thin host/scaffold. Re-verify this pattern holds (and note any new `<Tab>Composables.kt` files) in future passes.
