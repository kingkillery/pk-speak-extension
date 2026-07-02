# Android Design System (DESIGN.md token contract)

Source: `DESIGN.md` (repo root), added 2026-07-02 as part of the Android redesign effort.

## Product posture
Pi Speak Android is framed as an "operator cockpit" for remote coding agents — fast voice turns, gateway health, session routing, background-agent awareness. Calm field console, not a generic chat UI.

## Palette (standard build — warm paper + terracotta accent)
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
| `Success` | `#2E7D52` | Connected/live success (paired with text) |
| `Warn` | `#C97E1A` | Reconnecting/wait state (paired with text) |
| `Error` | `#B3261E` | Errors/destructive actions (paired with text) |

Boox/e-ink build is a separate palette: pure ink/paper/chrome greys only, color is never the sole status signal.

## Typography
- Large headings: serif, quiet paper-console identity.
- Body/controls: platform sans, 15-17sp, line-height 1.45-1.55.
- Command/session metadata: monospace only where it carries code/path semantics.
- Data/status numbers: tabular or monospace where alignment matters.
- Labels: sentence case unless a deliberate console tag.

## Spacing and shape
- Base spacing unit: 4dp.
- Screen gutters: 16dp standard, 12dp in dense cockpit rows.
- Primary panels: 24dp radius. Chips/buttons: 12-18dp radius (circles only for single-icon actions).
- Minimum touch target: 44dp standard, 56dp e-ink.

## Named components (design contract → implementation)
- `HeaderSection`: compact command bar, menu affordance, centered destination title, gateway status chip, configure action. (Reworked in `MainActivity.kt` as part of this redesign — see git diff 2026-07-02.)
- `PiSpeakDrawer`: warm paper nav sheet, selected row fill, profile footer.
- `StudioTabContent`: cockpit screen — status strip, conversation panel, quick command chips, composer. Implementation extracted into `StudioComposables.kt` (see `wiki/concepts/studio-composables-structure.md`).
- `ConnectionErrorBanner`: dark error strip, blocking gateway failures only.
- `GatewaySessionRow`: session/agent lane row; status badges pair color with text.

## Interaction/non-goal constraints worth enforcing in review
- Every clickable surface needs a visible pressed/selected/focus affordance.
- Voice/live states must use text labels in addition to color (not color alone).
- Loading/progress states must preserve cancel/stop access.
- Empty states must tell the operator what to do next (see `StudioIdleState` in StudioComposables.kt).
- No emoji icons in visible UI. No blue/purple AI gradients. No raw black/white except Boox contrast needs.

## Status
Living contract — re-verify this page against `DESIGN.md` each pass; flag drift in `wiki/log.md` rather than editing DESIGN.md or source.
