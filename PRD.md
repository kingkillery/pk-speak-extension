# Pi Speak Provider Abstraction PRD

## Problem Statement

Pi Speak already gives a developer a mobile voice interface for a local Pi coding-agent workflow. The missing product capability was provider choice: the mobile app and gateway were effectively tied to Pi because the agent turn path was hardcoded to `pi.sendUserMessage()` and Pi lifecycle events.

Users should be able to keep the same phone experience, STT, TTS, Telegram bridge, and Tailscale transport while choosing whether a turn goes to Pi or Codex.

## What Was Already Built

The existing repository already included the core product:

- Native Android app for setup, voice recording, text fallback, route selection, reply display, and audio playback.
- Mobile web/PWA remote client served by the extension.
- HTTP gateway with auth, local bypass, request limits, rate limits, diagnostics, and audio artifact serving.
- Telegram phone bridge for text and voice turns.
- Remote STT through OpenAI or local faster-whisper.
- Multi-provider TTS through legacy speak11, Edge, OpenAI, or ElevenLabs.
- Wake-word listener with `PK` activation.
- Session routing with names, aliases, compact PK1/PK2 lanes, and an Ink admin pane.

This work does not replace those pieces. It abstracts the agent dispatch path underneath them.

## MVP Definition

The MVP is:

- Android app: existing native Android client remains compatible.
- Pi provider: existing Pi behavior remains the default and unchanged from the user's perspective.
- Codex provider: new provider selected by configuration.
- Provider switching: `AGENT_PROVIDER=pi|codex`.
- Launch path selection: Android can send an optional working directory for turns started from the phone; host defaults remain configurable through environment variables.
- Shared turn result: both providers return text chunks that the existing gateway can turn into `replyText` and optional reply audio.

## Priorities

P0:

- Preserve the existing Android and HTTP API contracts as backward-compatible surfaces.
- Preserve Pi as the default provider.
- Add provider selection through `AGENT_PROVIDER`.
- Add a backward-compatible Android launch-path setting for per-turn working directory selection.
- Implement a typed provider interface.
- Implement Codex through `codex app-server` as the primary path.
- Keep streaming response chunks through the provider contract.
- Keep STT and TTS untouched.

P1:

- Use `codex exec --json` as a fallback when app-server startup fails.
- Add provider metadata to turn diagnostics.
- Support Codex model override through `AGENT_MODEL`.
- Support basic steering through the Codex app-server `turn/steer` method.
- Support default launch path configuration through host environment variables.

P2:

- Surface provider selection in the Android app UI.
- Add richer provider health diagnostics.
- Add per-provider routing controls.
- Add persistent Codex thread/session management UI.
- Add provider-specific auth/setup checks.
- Validate or browse host-side workspaces instead of relying on manual path entry.

## Phase 1: Personal Tailscale Use

Phase 1 assumes a single developer using a trusted machine and phone over localhost, LAN, Tailscale Serve, or an HTTPS tunnel.

Requirements:

- Keep the current HTTP API backward compatible.
- Require no mobile app update to switch providers.
- Let the Android app optionally choose the working directory for turns it launches.
- Use environment config on the host machine.
- Keep one active remote turn with bounded queueing.
- Return deterministic busy/rate-limit responses instead of unlimited concurrency.
- Use existing local TTS for spoken replies.

## Phase 2: Wider Release

Phase 2 can expand beyond the current personal workstation model.

Likely additions:

- Multi-transport support beyond Tailscale and ad hoc tunnels.
- Multi-user auth and authorization.
- Per-user provider/session routing.
- Managed STT/TTS options.
- iOS client.
- Hosted relay or Cloudflare transport.
- Provider setup wizard and health checks.

## User Stories

Send voice prompt:

As a developer away from the keyboard, I want to tap the phone mic, speak a request, and have Pi Speak transcribe it, send it to the configured agent provider, and show the transcript and reply.

Receive voice response:

As a developer using headphones or walking around, I want the response to be synthesized into audio and played on my phone when I request audio replies.

Switch providers:

As a developer, I want to set `AGENT_PROVIDER=pi` or `AGENT_PROVIDER=codex` before starting the gateway so the same Android app can talk to either backend without changing the mobile interface.

Choose launch path:

As a developer, I want to set a launch path in Android settings so voice or text turns run against the project directory I intend instead of whatever directory the gateway process started from.

Steer agent mid-task:

As a developer, I want spoken follow-up guidance to be sent to the active provider while work is in progress when the provider supports steering, so I can redirect a task without waiting for the whole turn to finish.

## Acceptance Criteria

- With no new environment variables, Pi Speak behaves as before using Pi.
- With `AGENT_PROVIDER=codex`, remote text turns are sent to Codex.
- With `AGENT_PROVIDER=codex`, remote voice turns still run through existing STT first.
- Reply audio still uses existing TTS.
- Android adds an optional launch-path field while older clients continue to work without sending it.
- The HTTP response shape still includes `replyText`, `transcript`, and optional `audioUrl`.
- Codex app-server is attempted before `codex exec --json`.
- Provider config supports `CODEX_BIN`, `PI_BIN`, `AGENT_MODEL`, and default launch path environment variables.

## Open Questions Deferred

- Should iOS be native, web-only, or both?
- Should provider switching become a runtime API instead of an environment variable?
- What auth model is needed for multi-user or wider release?
- Should Cloudflare become a first-class transport?
- Should STT and TTS move to managed cloud services for easier setup?
- How should multiple Codex threads map to Pi Speak session names and wake aliases?
- Should Android show provider health, model, and active thread metadata?
