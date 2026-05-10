# Pi Speak Remote / Android Polish & Hardening Checklist

> Generated from `PRODUCTION_GAP_ANALYSIS.md`, `DESIGN.md`, and extension source review.  
> Use this to decide sequencing, staffing, and whether to tackle items incrementally or in campaign blocks.

---

## How to read this

- **Phase 1** = Foundation. Must happen before the rest; stabilizes architecture, navigation, and app identity.
- **Phase 2** = Core Conversation. The main user loop (record, send, history, playback, retry).
- **Phase 3** = Launch Readiness. Observability, accessibility, test coverage, and release repeatability.
- **Extension** = Server-side / extension gaps that affect the remote experience regardless of client.

Each item includes a **validate** statement so you know what "done" looks like.

---

## Phase 1 — Foundation and Product Spine

### Architecture & State Modeling

| # | Item | Validate |
|---|------|----------|
| 1.1 | **Split monolithic screen into feature boundaries** — app shell, settings, conversation, and routing should be separate modules/screens with clean contracts. | ViewModels depend only on domain interfaces; no presentation class imports a concrete repository implementation. |
| 1.2 | **Replace flat `MainUiState`** with explicit state models for connection, route, turn, recorder, playback, and error. Each state should be named and mutually intelligible. | No UI branch depends on ad-hoc nullable field combinations to guess state. |
| 1.3 | **Fix repository leakage** — `MainViewModel` currently imports `PiSpeakRepositoryImpl.resolveAudioUrl` directly. Introduce a domain interface so the ViewModel is decoupled. | ViewModel has zero imports from `*Impl` packages. |

### Navigation & Settings

| # | Item | Validate |
|---|------|----------|
| 1.4 | **Add app-level navigation** with explicit startup/bootstrap handling and a real back-stack. | User can move between Conversation and Settings and return without losing state. |
| 1.5 | **Replace hidden settings drawer** with a clear settings surface. Connection state, active target, and setup must be discoverable. | A new user can find connection setup, session targeting, and send actions in under three taps from the landing screen. |
| 1.6 | **Theme appearance selector** — add System / Light / Dark toggle that persists instantly without requiring restart. | Toggle in settings changes theme immediately; survives process death. |
| 1.7 | **Environment configuration wiring** — stronger network client setup for release vs staging vs debug behavior. | Staging and release builds do not rely on placeholder networking assumptions. |

### Security & Identity

| # | Item | Validate |
|---|------|----------|
| 1.8 | **Network security config** — add `network_security_config.xml`, consider certificate pinning, and structured error mapping for release. | No cleartext-traffic-by-default; SSL errors produce actionable UI instead of silent failures. |
| 1.9 | **Release-safe app identity** — replace default Android launcher icons, disable backup of sensitive prefs, and review manifest defaults. | Launcher icon and label are branded; `android:allowBackup` does not expose tokens. |

### Phase 1 Validation

- [ ] Fresh install can open, configure, persist settings, restore state, and switch theme mode without restart.
- [ ] Core non-UI logic (settings, validation, state reduction, URL/auth handling) has deterministic unit coverage.
- [ ] App startup, settings restore, and connection editing behave consistently on Android 10 and Android 15.

---

## Phase 2 — Core Conversation Experience

### Turn History & State Contracts

| # | Item | Validate |
|---|------|----------|
| 2.1 | **Define explicit contracts** for turn history, recording lifecycle, voice upload states, playback states, and route-target selection. | Each conversation state has a named model; UI does not guess from stale fields. |
| 2.2 | **Conversation history** — persist and display recent turns with transcript, reply text, audio state, timestamp, and retry affordance. | Turn history survives navigation and process death well enough to orient the user. |
| 2.3 | **Session grouping / targeting chips** — show selected route target before any send action; allow quick switching. | Target is visible before recording or sending; common targets are chips, custom targets are a text field. |

### Recording & Playback Resilience

| # | Item | Validate |
|---|------|----------|
| 2.4 | **Recording lifecycle resilience** — handle interruptions, double-tap races, audio-focus conflicts, and partial-file cleanup. | Rapid tap-tap on record does not crash or leak files; phone call interrupts recording gracefully. |
| 2.5 | **Playback transport UX** — expose loading, playing, stopped, failed, and retry states per turn (not just fire-and-forget). | User can stop and replay audio; failed fetches show a retry button instead of hanging silently. |
| 2.6 | **Resilient upload & send** — retry affordances for upload failure, server-unavailable, and timeout cases. | Text and voice turns can be sent repeatedly across success, failure, retry, and playback scenarios without stale UI or broken recorder state. |

### Surface & Ergonomics

| # | Item | Validate |
|---|------|----------|
| 2.7 | **Push-to-talk with five explicit states** — idle, recording, uploading, waiting, failed. Label, color, and enabled state must change together. | Each state has a named visual treatment; no generic spinner-only representation. |
| 2.8 | **Text turn composer** — single-line collapsed field that expands while typing; send button uses the right semantic color. | Text send is reachable without scrolling on compact screens. |
| 2.9 | **Permission UX** — education, denial rationale, and permanently-denied recovery path to app settings. | First request explains why; denial shows a settings link; permanent denial shows a recovery panel. |
| 2.10 | **Adaptive layouts / tablet parity** — use `WindowSizeClass` for two-pane conversation + settings on expanded width. | Main flow remains usable on phone and tablet; critical actions stay visible without long scrolling. |
| 2.11 | **Error specificity** — every failure (unauthorized, offline, insecure connection, recorder fail, upload timeout) gets a specific message and recovery action. | No generic "something went wrong" where a concrete next step exists. |

### Phase 2 Validation

- [ ] Text and voice journeys produce consistent state transitions across phone and expanded-width layouts.
- [ ] Manual QA matrix covers Android 10 and Android 15 for voice, text, playback, permission deny, and offline recovery.

---

## Phase 3 — Hardening, Trust, and Launch Readiness

### Testing Depth

| # | Item | Validate |
|---|------|----------|
| 3.1 | **Unit tests** for ViewModels, repositories, settings, state reduction, and audio utilities. | `./gradlew test` covers core happy paths and critical failures. |
| 3.2 | **Compose UI tests** for major screens (conversation, settings, permission panels). | `./gradlew connectedCheck` or emulator tests run cleanly. |
| 3.3 | **Instrumentation tests** for end-to-end voice/text send, playback, and navigation flows. | `./gradlew connectedAndroidTest` passes on minSdk and latest Android. |

### Observability & Telemetry

| # | Item | Validate |
|---|------|----------|
| 3.4 | **Crash reporting** wired for release and staging; disabled or no-op in debug builds. | Crashes emit structured reports without leaking tokens or transcripts. |
| 3.5 | **Privacy-safe analytics** for critical journeys (record start, send success/failure, playback failure, route update). | Events do not include tokens, URLs with credentials, or transcript text. |
| 3.6 | **Diagnostics surface** — operator-relevant events (status refresh, send failure, upload timeout, playback failure) surfaced in-app without exposing secrets. | Diagnostics are useful for the person holding the phone, not a generic consumer. |

### Accessibility & Polish

| # | Item | Validate |
|---|------|----------|
| 3.7 | **Accessibility pass** — content descriptions, focus order, touch targets (48 dp min), and state announcements. | TalkBack can navigate the main flow without ambiguity. |
| 3.8 | **Contrast review** — all text and interactive elements meet WCAG contrast ratios against chosen surfaces. | No manual inspection flags illegible text. |
| 3.9 | **Branded assets** — launcher icons, adaptive icons, and notification icons replace default Android placeholders. | `PROJECT_ICONS.md` is maintained and assets exist for all densities. |
| 3.10 | **Loading & empty states** — every async operation has a named loading state; empty history has a useful zero-state. | No blank screens or ambiguous delays. |

### Release Repeatability

| # | Item | Validate |
|---|------|----------|
| 3.11 | **CI / local release commands** — `assembleDebug`, `assembleStaging`, `assembleRelease`, and `test` run cleanly and repeatably. | A new checkout can produce all three variants with one command. |
| 3.12 | **Documented release checklist** covering manual device QA, network edge cases, permission cases, accessibility verification, and build provenance. | Checklist is executable and repeatable; evidence is captured per run. |
| 3.13 | **Build-type behavior gating** — debug logging, strict-mode, and analytics are correctly toggled per build variant. | Release builds do not emit debug logs or enable cleartext. |

### Phase 3 Validation

- [ ] Accessibility audit passes for major surfaces.
- [ ] Same release checklist passes on minSdk and latest Android before declaring production-ready.

---

## Extension / Server-Side Gaps

These affect the remote experience regardless of which client (native app, browser PWA, or Telegram) is used.

| # | Item | Context |
|---|------|---------|
| E.1 | **Query-token auth for audio replay** — `ALLOW_QUERY_TOKEN_FOR_AUDIO` exists but defaults to `false`. If native apps need query-string audio URLs (e.g. for MediaPlayer without header injection), decide whether to enable or implement a short-lived signed URL instead. | Gated in `control-server.ts`. |
| E.2 | **HTTPS enforcement clarity** — browser mic requires HTTPS; Tailscale Serve is the recommended path. Ensure `/pk-remote` warnings are explicit when serving over HTTP with non-localhost origins. | Currently prints a warning; verify it is surfaced in all modes. |
| E.3 | **Bluetooth base URL configurability** — `PI_SPEAK_BLUETOOTH_BASE_URL` is honored, but the fallback `192.168.44.1:8767` is hardcoded. Consider whether this should be user-configurable per profile. | Only relevant if Bluetooth tethering setup changes. |
| E.4 | **Rate-limit tuning for voice uploads** — voice turns upload larger binary payloads. Confirm body-size limits and rate-limit windows are appropriate for AAC/MPEG-4 files from mobile. | Configured but not load-tested from real mobile latency. |
| E.5 | **PWA offline shell** — `sw.js` exists but verify it caches the app shell well enough for "add to home screen" launches without network. | Currently functional; worth an explicit pass. |

---

## Quick Priority Matrix

| Item | User Impact | Effort | Suggested Order |
|------|-------------|--------|-----------------|
| 1.1 Split monolithic screen | High | High | First |
| 1.2 Explicit UI state model | High | High | First |
| 1.3 Fix repository leakage | Medium | Low | First |
| 1.5 Settings as real surface | High | Medium | Early |
| 1.6 Theme selector | Medium | Low | Early |
| 1.8 Network security config | Medium | Medium | Early |
| 2.2 Conversation history | High | High | Mid |
| 2.4 Recording resilience | High | Medium | Mid |
| 2.5 Playback transport | High | Medium | Mid |
| 2.7 Five-state push-to-talk | High | Medium | Mid |
| 2.9 Permission UX | Medium | Medium | Mid |
| 2.10 Adaptive layouts | Medium | High | Late |
| 3.1–3.3 Testing depth | Medium | High | Late |
| 3.4 Crash reporting | Low | Low | Late |
| 3.7 Accessibility | Medium | Medium | Late |
| 3.12 Release checklist | Low | Low | Last |

---

## Open Decisions

1. **Scope of MVP vs full refactor** — Do you ship the browser PWA as the primary mobile surface while the native app catches up, or pause PWA work and focus all mobile effort on native?
2. **Tablet priority** — Is expanded-width support a launch blocker or a fast-follow?
3. **Telemetry provider** — Crashlytics? Self-hosted? No-op for now?
4. **Play Store vs sideload** — A Play Store launch requires policy compliance (location, mic disclosures, data safety form). Sideload avoids that but limits distribution.
5. **Bluetooth mode investment** — Is Bluetooth tethering a primary path, or should Tailscale + LAN remain the focus?

---

*Next step: Pick a phase (or a subset) and we can break it into tasks, estimate, and start implementation.*
