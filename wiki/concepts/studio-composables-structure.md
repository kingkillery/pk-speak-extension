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
    - `StudioIdleState(transmissionMode, targetSession, gatewayStatus, modifier)` — minimal connected-to-computer empty state shown when there's no conversation yet.
      - `ConnectionGlyph(gatewayStatus)` — centered computer/command glyph with connected status dot.
      - `IdleHintRow(label, value)` — key/value rows inside the Gateway/Target/Voice card.
  - `StudioComposer(...)` (`@OptIn(ExperimentalPermissionsApi)`, private) — input row: text field + record/send controls.
    - `StudioComposerActions(...)` — button cluster (live session start/stop, record trigger, stop-and-send, send text).
      - `StudioPillButton(text, textColor, backgroundColor, onClick)` — shared pill-shaped action button.

## Notable concept: `StudioIdleState`
Empty-state composable satisfying the updated design direction: minimal, premium, OpenAI Codex-mobile-like connection to a computer. It centers a connection glyph, uses the headline "Connected to your computer", explains the routing in one short sentence, and keeps Gateway/Target/Voice details in a compact secondary card.

## Relationship to MainActivity.kt
`MainActivity.kt` shrank from a much larger single file (net -1151 lines in this diff) by delegating Studio-tab rendering to this file. `HeaderConnectionStateTest.kt` received a small follow-up diff (+3/-3), suggesting a minor rename/signature touch-up tied to the `HeaderSection` rework rather than a full behavior change — worth a quick confirm read before merge.

## Status
Updated 2026-07-02 after commit `4bbb3ea` and the follow-up minimal idle-state redesign. Re-check after the next Android visual pass to confirm screenshot/test coverage still matches.

## Update (pass 3, 2026-07-02) — extraction pattern generalized
The `MainActivity.kt` split is not limited to Studio. By pass 3, `MainActivity.kt` dropped from ~4941 to 2245 lines as two more tab-composable files appeared:
- `SessionsComposables.kt` (~1776 lines) — `SessionsTabContent` (public entry) with a pane toggle (`SessionsPaneToggle`: "Hub" / "Ops" / "History") switching between `GatewaySessionsPane`, `GatewayOpsPane`, and `LocalTurnHistoryPane`. `GatewaySessionsPane` owns hub launch (OMPK), Colab launch, and collab-join flows plus a `GatewaySessionsHeader`.
- `SettingsComposables.kt` (~1097 lines) — `SettingsTabContent` (public entry, `@OptIn(ExperimentalMaterial3Api)`) plus a `WorkspaceFileViewerDialog` and `formatWorkspaceFileSize` helper.

Pattern: each major tab (`Studio`, `Sessions`, `Settings`) is being pulled into its own `<Tab>Composables.kt` file with a public `<Tab>TabContent` entry point, private helper composables below it. `MainActivity.kt` is trending toward a thin host/scaffold. Re-verify this pattern holds (and note any new `<Tab>Composables.kt` files) in future passes.
