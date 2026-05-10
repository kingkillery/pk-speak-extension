---
version: alpha
name: Pi Speak Android
description: Operator-grade mobile command surface for voice and text control of a coding machine.
colors:
  primary: "#183249"
  on-primary: "#F7FAFC"
  primary-container: "#DCEAF3"
  on-primary-container: "#102332"
  accent: "#C95532"
  on-accent: "#FFF8F2"
  accent-container: "#F6D8CB"
  success: "#17765D"
  on-success: "#F4FFFA"
  success-container: "#D8F0E7"
  warning: "#A86D12"
  on-warning: "#FFF8E8"
  warning-container: "#F3E0B8"
  error: "#B3261E"
  on-error: "#FFFFFF"
  error-container: "#F9DAD5"
  neutral-0: "#FFFFFF"
  neutral-5: "#F7F8F5"
  neutral-10: "#ECEFEB"
  neutral-20: "#D7DDD7"
  neutral-50: "#738078"
  neutral-80: "#2B3630"
  neutral-90: "#17211C"
  surface: "#FBFCF8"
  on-surface: "#17211C"
  surface-container: "#F1F4EF"
  surface-container-high: "#E7ECE5"
  outline: "#8B978F"
  outline-variant: "#CCD4CD"
  dark-surface: "#101A22"
  dark-surface-container: "#172533"
  dark-on-surface: "#EEF3EE"
typography:
  display-sm:
    fontFamily: Roboto
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: 0px
  headline-lg:
    fontFamily: Roboto
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.16
    letterSpacing: 0px
  headline-md:
    fontFamily: Roboto
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: 0px
  title-lg:
    fontFamily: Roboto
    fontSize: 20px
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: 0px
  title-md:
    fontFamily: Roboto
    fontSize: 17px
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: 0px
  body-lg:
    fontFamily: Roboto
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0px
  body-md:
    fontFamily: Roboto
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
  body-sm:
    fontFamily: Roboto
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0px
  label-lg:
    fontFamily: Roboto
    fontSize: 13px
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: 0px
  label-sm:
    fontFamily: Roboto
    fontSize: 11px
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: 0px
rounded:
  none: 0px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 20px
  control: 16px
  record: 28px
  full: 9999px
spacing:
  none: 0px
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
  screen-margin-compact: 16px
  screen-margin-medium: 24px
  screen-margin-expanded: 32px
  touch-target: 48px
  top-bar-height: 64px
  bottom-bar-height: 80px
  record-size-compact: 128px
  record-size-expanded: 152px
components:
  app-top-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.title-lg}"
    height: "{spacing.top-bar-height}"
  status-strip:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    borderColor: "{colors.outline-variant}"
    rounded: "{rounded.sm}"
    typography: "{typography.label-lg}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    borderColor: "{colors.outline-variant}"
    rounded: "{rounded.sm}"
    padding: "{spacing.lg}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    typography: "{typography.label-lg}"
    height: "{spacing.touch-target}"
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    typography: "{typography.label-lg}"
    height: "{spacing.touch-target}"
  button-secondary:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.primary}"
    borderColor: "{colors.outline-variant}"
    rounded: "{rounded.control}"
    typography: "{typography.label-lg}"
    height: "{spacing.touch-target}"
  chip-selected:
    backgroundColor: "{colors.primary-container}"
    textColor: "{colors.on-primary-container}"
    borderColor: "{colors.primary}"
    rounded: "{rounded.full}"
    typography: "{typography.label-lg}"
  chip-unselected:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    borderColor: "{colors.outline-variant}"
    rounded: "{rounded.full}"
    typography: "{typography.label-lg}"
  record-idle:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.record}"
    size: "{spacing.record-size-compact}"
  record-active:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-error}"
    rounded: "{rounded.record}"
    size: "{spacing.record-size-compact}"
  text-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    borderColor: "{colors.outline}"
    rounded: "{rounded.control}"
    typography: "{typography.body-md}"
  error-panel:
    backgroundColor: "{colors.error-container}"
    textColor: "{colors.error}"
    rounded: "{rounded.sm}"
    padding: "{spacing.lg}"
---

# Pi Speak Android Design

Format source: [DESIGN.md spec](https://github.com/kingkillery/design.md/blob/main/docs/spec.md).

## Overview

Pi Speak Android is an operator console for sending voice and text turns to a coding machine. The perfect refactor should feel fast, local, and trustworthy: when the app opens, the user should immediately know which machine is selected, where the next turn will route, whether the connection is usable, and what the remote system is doing now.

The visual direction is a compact command surface with warm signal accents. It should not feel like a marketing app, a toy walkie-talkie, or a decorative dashboard. The app is used in short bursts, often under friction, so hierarchy beats ornament: status first, target second, action third, history close by.

The native Android implementation should use Material 3 and Compose, but the product personality should come from these tokens, custom app-owned icons, concise copy, and state-specific surfaces rather than from generic Material defaults. Interpret typography `px` values as `sp` and spacing, shape, and size `px` values as `dp` in Compose token adapters.

## Colors

The palette balances command clarity with a recognizable Pi Speak identity. It moves away from the older warm-beige-heavy look and uses calmer neutral surfaces, a strong gateway blue, and a single high-energy record/send accent.

- **Gateway Blue (`primary`, `#183249`):** Navigation, screen titles, active route emphasis, and stable system identity.
- **Signal Coral (`accent`, `#C95532`):** Record, send, and the single highest-priority action on a screen.
- **Link Green (`success`, `#17765D`):** Connected, trusted, sent, and ready states.
- **Attention Amber (`warning`, `#A86D12`):** Degraded connection, insecure manual HTTP, pending permission, or retryable delay.
- **Danger Red (`error`, `#B3261E`):** Failed send, unauthorized token, recorder failure, and destructive actions.
- **Operational Neutrals:** Use `surface`, `surface-container`, and `outline-variant` to create hierarchy without large shadows or tinted blobs.

Dark mode should invert the surface stack without changing the semantic meaning of colors. Accent colors may soften slightly in dark mode, but recording and error states must remain unmistakable.

## Typography

Use Roboto or the Android platform default for all production UI. Avoid serif display styling in functional screens; it slows scanning and makes the app feel less native. Keep type sizes stable across viewports and use layout, not viewport-scaled text, for adaptation.

- **Display and headlines:** Reserved for the app name, empty states, and first-run setup moments. Do not use display type inside cards.
- **Titles:** Use for panels such as Connection, Target, Reply, and Diagnostics.
- **Body:** Use for instruction copy and turn content. Body copy must be plain and short.
- **Labels:** Use for state pills, route chips, metadata, and button labels. Labels are never all-caps unless the string is a short system code.

No negative letter spacing. Long machine names, URLs, workspace paths, transcripts, and reply text must wrap or ellipsize predictably without changing the size of controls around them.

## Layout

The first screen is the conversation surface, not a landing page. The primary layout order is:

1. Current machine, route target, connection state, and session summary.
2. Primary turn controls: push-to-talk, text fallback, and send state.
3. Latest response and playback controls.
4. Recent turn history.
5. Secondary setup and diagnostics entry points.

Use a 4 dp micro-grid and an 8 dp visual rhythm. Keep a single-column layout on compact phones. On expanded width, use a two-pane layout: conversation and turn history on the main pane, connection, target, and diagnostics on the supporting pane. Use `WindowSizeClass` so tablets and foldables are first-class, not stretched phone layouts.

Primary actions must remain reachable without long scrolling. On compact screens, keep record and text send near the bottom safe area. On expanded screens, keep record/send anchored in the main pane while status and target controls remain visible.

## Elevation & Depth

Use tonal layering and 1 dp borders for hierarchy. Avoid heavy shadows, glass blur, background gradients, decorative blobs, and nested cards. A screen can have panels, but panels should be flat, dense, and obviously functional.

Depth levels:

- **Base:** `surface`, used for the scaffold background.
- **Panel:** `surface-container`, used for status strips, settings groups, and supporting information.
- **Raised content:** `surface` with `outline-variant`, used for turn cards and editable panels.
- **Critical state:** Semantic containers such as `error-container`, `warning-container`, or `success-container`.

Animation should communicate state transitions only: recording pulse, upload progress, playback progress, route update, and retry. Avoid ambient motion.

## Shapes

The refactor should tighten the current large-radius style. Cards and panels use 8 dp corners. Buttons and fields use 16 dp corners. Chips remain pill shaped. The record control can use a larger 28 dp radius because it is a purpose-built control, not a card.

Shape should communicate function:

- **8 dp:** Panels, turn cards, diagnostics rows, and setup notices.
- **12-16 dp:** Buttons, text fields, menus, and persistent controls.
- **Full pill:** Route chips, connection mode chips, and compact status pills.
- **28 dp:** Primary record control only.

Do not mix sharp and highly rounded containers in the same section.

## Components

**App Shell:** Use a top app bar for product identity and a one-line live status. Use bottom navigation only for top-level Conversation and Settings on compact screens. On expanded screens, prefer a navigation rail.

**Status Strip (Variation 6):** The primary line is a single, human-readable state summary. Do not include route/session chatter in that summary. Keep machine + target as a quieter secondary line, and keep advanced/diagnostic fields behind an explicit Details affordance.

**Machine Profile Picker:** Present saved machines as a compact picker or chip row. Each profile should show name, connection mode, and a short URL host. Tokens stay hidden unless editing.

**Target Selector:** Use chips for common route targets and a text field for custom targets. The selected target must be visible before recording or sending.

**Push-to-Talk Control:** This is the signature control. It has five states: idle, recording, uploading, waiting, and failed. The label, color, and enabled state must change together. Do not represent these states only with a spinner.

**Text Turn Composer:** Keep text fallback visible and fast. Use a single-line collapsed field that expands while typing. The send button uses the primary or accent token depending on whether voice or text is the current action.

**Turn Cards (Variation 6):** Recent turns read like a compact timeline: source, status, transcript, reply, audio state, retry action, and timestamp. Do not repeat route/target in every card; show it only when the user explicitly expands details.

**Reply Playback:** Use clear play, stop, loading, failed, and replay states. Playback state belongs to the turn, not only to the whole screen.

**Permission and Setup Panels:** Explain only the blocker and the next action. Microphone denial, missing token, unauthorized token, offline gateway, and insecure manual connection each get a specific message and recovery action.

**Settings:** Settings are a real destination, not a hidden drawer. Group them as Connection, Machine Profiles, Audio Behavior, Appearance, and Diagnostics. Destructive actions require confirmation.

**Diagnostics:** Show operator-relevant events without exposing secrets. Good diagnostics include status refresh, route update, send failure, voice upload failure, playback failure, and selected machine changes.

**Icons:** Use app-owned PNG drawables for shipping icons and maintain `PROJECT_ICONS.md` when icon assets are added. Avoid mixing generic icon styles across the same screen.

## Do's and Don'ts

- Do keep the current machine, route target, and connection state visible before any send action.
- Do reserve Signal Coral for recording, sending, or the single most important action.
- Do model connection, recording, upload, waiting, playback, and error states explicitly in UI.
- Do support System, Light, and Dark appearance using the same semantic tokens.
- Do design every major screen for compact and expanded layouts.
- Do use short, direct copy that names the next action.
- Don't make the app open to a hero, marketing page, or decorative dashboard.
- Don't bury connection setup, token state, or route target inside a long scroll.
- Don't rely on beige backgrounds, gradients, or large soft cards to make the app feel branded.
- Don't use negative letter spacing, viewport-scaled type, or text that changes control dimensions.
- Don't show full remote tokens in normal UI, logs, screenshots, or diagnostics.
- Don't use generic error text where a specific recovery action exists.

## Refactor North Star

The ideal app is a reliable remote-control cockpit:

- **Cold open:** The user sees connection, machine, route, and readiness in one glance.
- **One-handed turn:** Voice and text turns are reachable without hunting.
- **State clarity:** Every wait, failure, retry, permission issue, and playback state has a named visual state.
- **Recoverability:** Offline, unauthorized, insecure, and permission-denied paths each have a short path back to working.
- **Continuity:** Recent turns survive navigation and process death well enough to orient the user.
- **Operator trust:** Diagnostics are useful, privacy-safe, and written for the person using the app, not for a generic consumer audience.
