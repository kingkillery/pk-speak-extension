# Android Design System (DESIGN.md token contract)

Source: `DESIGN.md` (repo root), added 2026-07-02 as part of the Android redesign effort.

## Product posture
Pi Speak Android is now framed as a calm mobile connection surface for coding agents — closer to the OpenAI Codex mobile app connected to a computer than an admin dashboard. The desired feel is minimal, premium, sparse, and confidence-building.

## Palette (standard build — quiet off-white + monochrome accent)
| Token | Hex | Use |
|---|---:|---|
| `Canvas` | `#F7F7F4` | App background |
| `SurfacePaper` | `#FFFFFF` | Composer, sheets, primary panels |
| `SurfaceSubtle` | `#F1F1EE` | Inset panels, empty-state glyphs |
| `SurfaceMuted` | `#E6E6E1` | Disabled controls, pressed fills |
| `SelectedFill` | `#EDEDEA` | Selected nav row, quick command chips |
| `Ink` | `#171717` | Primary text and monochrome accent |
| `InkMuted` | `#6B6B66` | Secondary text, labels |
| `Line` | `#E1E1DC` | Hairline borders |
| `Accent` | `#171717` | Primary send/record actions |
| `AccentSoft` | `#F1F1EE` | User messages, soft accent fills |
| `Success` | `#147A4A` | Connected/live success (paired with text) |
| `SuccessSoft` | `#E2F4EA` | Connected status dot fill |
| `Warn` | `#9A6A16` | Reconnecting/wait state (paired with text) |
| `Error` | `#B42318` | Errors/destructive actions (paired with text) |

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
- `StudioTabContent`: cockpit screen — status strip, conversation panel, quick command chips, composer. `StudioIdleState` should center the connected-to-computer story: glyph, headline, short explanation, compact Gateway/Target/Voice card, quiet command hint. Implementation lives in `StudioComposables.kt` (see `wiki/concepts/studio-composables-structure.md`).
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
