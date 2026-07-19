# Pi Speak Android Design System

## 1. Product posture

Pi Speak is a spacious, voice-first mobile hub for coding agents — the operator's home base for watching sessions run, reviewing what an agent did, and approving what it wants to do next. The standard Android build should feel warm and confidence-building rather than clinical: generous spacing, plain language over jargon, and a clear visual difference between "the agent is talking" and "you're talking."

## 2. Palette — Sage & Clay

Standard Android build uses a warm, sage-tinted off-white surface. Two colors carry meaning deliberately (this build does not keep the accent monochrome): sage is the primary/live UI color — active tabs, nav selection, connected status; clay is the action accent — record/send, avatars, primary taps.

| Token | Hex | Use |
|---|---:|---|
| `Canvas` | `#F7F6F0` | App background |
| `SurfacePaper` | `#FEFDF9` | Composer, sheets, primary panels |
| `SurfaceSubtle` | `#EDEDE1` | Inset panels, empty-state glyphs |
| `SurfaceMuted` | `#E3E3D3` | Disabled controls, pressed fills |
| `SelectedFill` | `#E3E8DA` | Selected nav row, active tab, quick command chips (sage wash) |
| `Ink` | `#2B2E24` | Primary text |
| `InkMuted` | `#767A64` | Secondary text, labels |
| `Line` | `#DEDECD` | Hairline borders |
| `Accent` | `#C1653E` | Primary send/record actions, avatars (clay) |
| `AccentSoft` | `#F7EBE6` | User messages, soft accent fills |
| `Success` | `#5F7548` | Connected/live status, done states — also the primary "sage" UI color, paired with text |
| `SuccessSoft` | `#EAEDE0` | Connected status dot fill |
| `Warn` | `#9C6B1E` | Reconnecting/wait state, paired with text |
| `Error` | `#B23B23` | Errors/destructive actions, paired with text |

Boox/e-ink build is separate: pure ink/paper/chrome greys only. Color is never the sole status signal.

## 3. Typography

Compose theme owns the scale.

- Large headings: platform sans (Default), semibold — a friendlier, more spacious voice than a literary serif.
- Body and controls: platform sans, 15-17sp, line-height 1.45-1.55.
- Command/session metadata and timestamps: monospace only where it carries code/path/time semantics.
- Data/status numbers: tabular or monospace where alignment matters.
- Labels: sentence case unless the label is a deliberate console tag.
- No jargon in copy an average, non-technical user would read: say what happened ("Looked through 4 files," "Ready to save this change") instead of naming the mechanism (`tool_call`, `diff`, `commit`).

## 4. Spacing and shape

- Base spacing unit: 4dp.
- Screen gutters: 20-24dp standard (spacious by default), 12dp only in dense cockpit rows.
- Primary panels/cards: 20-24dp radius, generous internal padding (16-20dp).
- Chips/buttons: 12-18dp radius, circles only for single-icon/action controls.
- Minimum touch target: 44dp standard, 56dp e-ink.
- Prefer fewer, larger cards per screen over dense lists — err toward whitespace.

## 5. Components

- `HeaderSection` (MainActivity.kt): compact command bar with menu affordance, centered destination title, explicit gateway status chip, and configure action.
- `PiSpeakDrawer` (MainActivity.kt): warm paper navigation sheet with selected row fill (sage wash) and profile footer.
- `StudioComposables.kt`: cockpit screen pieces — `StudioCockpitLayout`, status strip, conversation panel, chat message + actions, transcript stream, turn progress, `StudioIdleState` (centered connected-to-computer glyph, minimal headline/body, Gateway/Target/Voice card, quiet command hint), composer + pill buttons. Uses theme tokens, no raw hex.
- `SettingsComposables.kt`: `SettingsTabContent` plus workspace file viewer dialog.
- `SessionsComposables.kt`: `SessionsTabContent`, gateway sessions/ops panes, session rows and badges (status color always paired with text), local turn history.
- `HubPortalComposables.kt`: Agent Hub portal — hub agent list/snapshot, chat/kill/revive actions.
- `ConnectionErrorBanner` (MainActivity.kt): dark error strip only for blocking gateway failures.

## 6. Interaction states

- Every clickable surface needs a visible pressed/selected/focus affordance.
- Voice/live states must use text labels in addition to color.
- Loading/progress states must preserve cancel/stop access.
- Empty states should tell the operator what to do next.
- Tool-use / agent activity collapses into a single tappable summary row (e.g. "Looked through 4 files") rather than a raw log — expand on tap for detail.
- Anything that needs operator approval renders as a distinct bordered card with two clearly labeled buttons (primary + "Not now"), never a bare inline link.

## 7. Non-goals and constraints

- No emoji icons in visible UI; use text labels, simple glyphs, or vector/material icons.
- No blue/purple AI gradients.
- No raw black/white except Boox constraints and text contrast needs.
- Do not weaken voice/agent functionality to improve appearance.
