# Android Design System (DESIGN.md token contract)

Source: `DESIGN.md` (repo root). Replaced 2026-07-12: the monochrome "paper" system (added 2026-07-02) was superseded by the Sage & Clay system after a mobile Agent Hub mockup review.

## Product posture
Pi Speak Android is a spacious, voice-first mobile hub for coding agents — home base for watching sessions run, reviewing what an agent did, and approving what it wants to do next. Warm and confidence-building rather than clinical: generous spacing, plain language over jargon, a clear visual difference between agent and user messages.

## Palette (standard build — Sage & Clay)
| Token | Hex | Use |
|---|---:|---|
| `Canvas` | `#F7F6F0` | App background |
| `SurfacePaper` | `#FEFDF9` | Composer, sheets, primary panels |
| `SurfaceSubtle` | `#EDEDE1` | Inset panels, empty-state glyphs |
| `SurfaceMuted` | `#E3E3D3` | Disabled controls, pressed fills |
| `SelectedFill` | `#E3E8DA` | Selected nav row, active tab (sage wash) |
| `Ink` | `#2B2E24` | Primary text |
| `InkMuted` | `#767A64` | Secondary text, labels |
| `Line` | `#DEDECD` | Hairline borders |
| `Accent` | `#C1653E` | Primary send/record actions, avatars (clay) |
| `AccentSoft` | `#F7EBE6` | User messages, soft accent fills |
| `Success` | `#5F7548` | Connected/live status — also the primary "sage" UI color, paired with text |
| `SuccessSoft` | `#EAEDE0` | Connected status dot fill |
| `Warn` | `#9C6B1E` | Reconnecting/wait state, paired with text |
| `Error` | `#B23B23` | Errors/destructive actions, paired with text |

Boox/e-ink build is a separate palette: pure ink/paper/chrome greys only, color is never the sole status signal.

## Typography
- Large headings: platform sans (Default), semibold — dropped the old serif "paper" identity for a friendlier, more spacious voice.
- Body/controls: platform sans, 15-17sp, line-height 1.45-1.55.
- Command/session metadata: monospace only where it carries code/path semantics.
- Data/status numbers: tabular or monospace where alignment matters.
- Labels: sentence case unless a deliberate console tag.
- Copy avoids jargon (`tool_call`, `diff`, `commit`) in favor of plain language ("Looked through 4 files," "Ready to save this change") — the target user is not assumed to be technical.

## Spacing and shape
- Base spacing unit: 4dp.
- Screen gutters: 20-24dp standard (spacious by default), 12dp in dense cockpit rows.
- Primary panels: 20-24dp radius, generous internal padding. Chips/buttons: 12-18dp radius (circles only for single-icon actions).
- Minimum touch target: 44dp standard, 56dp e-ink.
- Prefer fewer, larger cards per screen over dense lists.

## Named components (design contract → implementation)
- `HeaderSection`: compact command bar, menu affordance, centered destination title, gateway status chip, configure action.
- `PiSpeakDrawer`: warm paper nav sheet, selected row fill (sage wash), profile footer.
- `StudioTabContent`: cockpit screen — status strip, conversation panel, quick command chips, composer. `StudioIdleState` centers the connected-to-computer story: glyph, headline, short explanation, compact Gateway/Target/Voice card, quiet command hint. Implementation lives in `StudioComposables.kt` (see `wiki/concepts/studio-composables-structure.md`).
- `ConnectionErrorBanner`: dark error strip, blocking gateway failures only.
- `GatewaySessionRow`: session/agent lane row; status badges pair color with text.
- `HubPortalComposables.kt`: Agent Hub portal (hub agent list/snapshot, chat/kill/revive) — see `wiki/concepts/herdr-agent-hub-module.md` for the backing API.

## Interaction/non-goal constraints worth enforcing in review
- Every clickable surface needs a visible pressed/selected/focus affordance.
- Voice/live states must use text labels in addition to color (not color alone).
- Loading/progress states must preserve cancel/stop access.
- Empty states must tell the operator what to do next (see `StudioIdleState` in StudioComposables.kt).
- Tool-use/activity collapses into a tappable summary row, not a raw log; approval moments are a distinct bordered card with two labeled buttons.
- No emoji icons in visible UI. No blue/purple AI gradients. No raw black/white except Boox contrast needs.

## Status
Living contract — re-verify this page against `DESIGN.md` each pass; flag drift in `wiki/log.md` rather than editing DESIGN.md or source.
