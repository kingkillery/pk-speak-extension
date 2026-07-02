---
title: "pk-speak-extension Overview"
type: synthesis
tags: [pk-speak-extension, voice-control, remote-control, typescript, android]
status: in-progress
---

# pk-speak-extension

## Purpose
A cross-platform voice + remote-control extension for `pi-coding-agent` with three main surfaces:
- **Desktop extension core** (`index.ts` / TypeScript backend): command routing, session targeting, wake phrase handling, admin operations, logging, and control APIs.
- **Android companion app** (`android-app/`): Kotlin client for local Android controls and remote control actions.
- **Web remote UI** (`web/remote/`): browser-based mobile controller and supporting browser-side JS.

## Core architecture

### Extension runtime (`index.ts`, `control-server.ts`, `remote-turn-manager.ts`)
- Registers commands and session operators.
- Manages route normalization and conflict-safe resolution (`voice-routing.ts`, `session-routing.ts`, `session-routing-store.ts`).
- Maintains append-only operator/event history for UI toast/log updates (`session-events.ts`).
- Runs network-facing control APIs (`control-server.ts`) and turn orchestration (`remote-turn-manager.ts`).
- Routes remote turns through the provider abstraction in `agent-provider.ts`, `pi-agent-provider.ts`, and `codex-agent-provider.ts`; the same phone/browser clients can target `AGENT_PROVIDER=pi` or `AGENT_PROVIDER=codex`.
- Uses a shared HTTP auth token across providers. The temporary default is `P-K-Haxx1!`, overridden by `PI_SPEAK_HTTP_TOKEN`.

### Voice path
- Wake word + transcription glue from `listener/listener.py` and `stt.ts`.
- Text-to-speech through provider chain in `tts.ts`.
- Wake/command interpretation and session command parsing in `voice-session-command.ts`.

### Session management
- Core routing and alias logic: `session-routing.ts`.
- Persistent store + hydration: `session-routing-store.ts`.
- Admin operators (`/sess`, aliases, renames, removals) and compact dashboard support.

### UI
- `/sess ui` launches separate terminal pane and Ink app: `ui-launcher.ts`, `ui/admin.tsx`.
- Dashboard + toasts + actions in `ui/components/` and store hooks in `ui/hooks/useSessionStore.ts`.

### Android surface (`android-app/`)
- Main app shell and screens in Kotlin under `android-app/app/src/main/java/com/pkkidking/pispeak/`.
- Domain/data/viewmodel wiring plus repository and remote DTOs.
- Stores machine profiles, remote token, optional launch path, and connection mode.
- Supports Tailscale, Bluetooth local-link/PAN, and manual connection modes. Bluetooth mode allows HTTP local-link URLs without requiring Tailscale.

### Remote web app (`web/remote/`)
- `index.html` and `app.js` implement the mobile remote UI, session controls, and event display.

## Validation and quality
- Test files now include TS + Kotlin/Compose coverage updates (`tests/`, `android-app/app/src/test/...`).
- Documented operational runbooks and checks in:
  - `docs/CODEBASE_MAP.md`
  - `docs/REMOTE_OPERATING_GUIDE.md`
  - `docs/REMOTE_VALIDATION_CHECKLIST.md`
  - `docs/REMOTE_VALIDATION_RUN_SHEET.md`

## Operational stack / docs
- Primary docs and contracts:
  - `README.md`, `AGENTS.md`, `SYSTEM_CONTRACT.md`, `PRD.md`, `SPEC.md`, `KNOWN_ISSUES.md`
- New repository memory/wiki system scaffold added:
  - `wiki/`, `.llm-wiki/`, `.brv/`, `scripts/`, `kade/`, `.agent*`, `.agents*`, `.codex*`, `.claude*`

## Current work context
- `main` includes PR #13, "feat: bring Android app to functional parity with the web remote", merged on 2026-07-02 as `35fed0a`.
- The post-merge verifier run added local follow-up fixes for Android gateway archive/recover wiring, EventSource query-token auth, malformed gateway URL handling, workspace truncation display, and legacy agents-only inventory rendering.
- Latest validation evidence from the run: `npm test` passed 333 tests; Android `:app:testStandardDebugUnitTest :app:compileBooxDebugKotlin :app:assembleStandardDebug` succeeded; `git diff --check` returned exit 0 with only LF/CRLF warnings.
- See `wiki/sessions/2026-07-02-pr13-android-gateway-parity.md` for the run summary, skipped findings, and local changed-file list.
