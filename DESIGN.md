# Pi Speak Android Design System

## 1. Product posture

Pi Speak is an operator cockpit for remote coding agents: fast voice turns, gateway health, session routing, and background-agent awareness. The UI should feel like a calm field console, not a generic chat clone.

## 2. Palette

Standard Android build uses warm paper surfaces with one terracotta action accent.

| Token | Hex | Use |
|---|---:|---|
| `Canvas` | `#F4F1E9` | App background |
| `SurfacePaper` | `#FFFFFF` | Composer, sheets, primary panels |
| `SurfaceSubtle` | `#F0ECE2` | Inset panels, assistant/progress bubbles |
| `SurfaceMuted` | `#E9E3D6` | Disabled controls, pressed fills |
| `SelectedFill` | `#EDE7DB` | Selected nav row, quick command chips |
| `Ink` | `#211C16` | Primary text |
| `InkMuted` | `#6E665A` | Secondary text, labels |
| `Line` | `#E3DCCC` | Hairline borders |
| `Accent` | `#C2542F` | Primary send/record actions |
| `AccentSoft` | `#FBF1EC` | User messages, soft accent fills |
| `Success` | `#2E7D52` | Connected/live success, paired with text |
| `Warn` | `#C97E1A` | Reconnecting/wait state, paired with text |
| `Error` | `#B3261E` | Errors/destructive actions, paired with text |

Boox/e-ink build is separate: pure ink/paper/chrome greys only. Color is never the sole status signal.

## 3. Typography

Compose theme owns the scale.

- Large headings: serif, quiet paper-console identity.
- Body and controls: platform sans, 15-17sp, line-height 1.45-1.55.
- Command/session metadata: monospace only where it carries code/path semantics.
- Data/status numbers: tabular or monospace where alignment matters.
- Labels: sentence case unless the label is a deliberate console tag.

## 4. Spacing and shape

- Base spacing unit: 4dp.
- Screen gutters: 16dp standard, 12dp only in dense cockpit rows.
- Primary panels: 24dp radius.
- Chips/buttons: 12-18dp radius, circles only for single-icon/action controls.
- Minimum touch target: 44dp standard, 56dp e-ink.

## 5. Components

- `HeaderSection` (MainActivity.kt): compact command bar with menu affordance, centered destination title, explicit gateway status chip, and configure action.
- `PiSpeakDrawer` (MainActivity.kt): warm paper navigation sheet with selected row fill and profile footer.
- `StudioComposables.kt`: cockpit screen pieces — `StudioCockpitLayout`, status strip, conversation panel, chat message + actions, transcript stream, turn progress, `StudioIdleState` (headline + Gateway/Target/Voice hint rows + suggestion card), composer + pill buttons. Uses theme tokens, no raw hex.
- `SettingsComposables.kt`: `SettingsTabContent` plus workspace file viewer dialog.
- `SessionsComposables.kt`: `SessionsTabContent`, gateway sessions/ops panes, session rows and badges (status color always paired with text), local turn history.
- `ConnectionErrorBanner` (MainActivity.kt): dark error strip only for blocking gateway failures.

## 6. Interaction states

- Every clickable surface needs a visible pressed/selected/focus affordance.
- Voice/live states must use text labels in addition to color.
- Loading/progress states must preserve cancel/stop access.
- Empty states should tell the operator what to do next.

## 7. Non-goals and constraints

- No emoji icons in visible UI; use text labels, simple glyphs, or vector/material icons.
- No blue/purple AI gradients.
- No raw black/white except Boox constraints and text contrast needs.
- Do not weaken voice/agent functionality to improve appearance.
