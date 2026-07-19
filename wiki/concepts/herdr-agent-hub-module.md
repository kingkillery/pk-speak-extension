---
type: concept
title: "herdr-agent-hub-* Module"
created: 2026-07-13
updated: 2026-07-13
tags: []
status: developing
related: []
sources: 
  - pi-speak-extension PR #19 (819f6a2), herdr-agent-hub-live.ts
---

# herdr-agent-hub-* module and Agent Hub portal

Backs `/v1/herdr/agent*` routes in the pi-speak gateway. Originally observed in-flight 2026-07-02; landed via `218ed8a feat: expose agent hub through herdr gateway`, then upgraded from a read-only peek into an actionable portal by PR #19 `819f6a2 feat(agent-hub): actionable Agent Hub portal for Android + e-ink` (2026-07-11).

## Backend files
- `herdr-agent-hub-schema.ts` — parse-not-validate boundary: branded `HubAgentId`, `HubAgentStatus` (`running | idle | parked | aborted`), `HubAgentKind` (`main | sub | advisor | background`), `HubFolder`, `HubAgent`.
- `herdr-agent-hub-gateway.ts` — routing layer over an `AgentHubBinding`; now catches binding-thrown errors and surfaces them as clean 400s.
- `herdr-agent-hub-disk.ts` — `createDiskFallbackBinding(dashboardFn)`: read-only binding from the agent-hub-dashboard stale-while-revalidate scan (`canMutate: false`, mutations answer `409 hub_offline`). Since PR #19 this is only the fallback, no longer the default.
- `herdr-agent-hub-live.ts` (PR #19) — real `AgentHubBinding` wired into both `index.ts` and `headless-gateway.ts`:
  - `chat`: submits a normal turn targeted at the lane's name (same mechanism as `PK <session-name>`).
  - `kill`: archives the lane.
  - `revive`: resolves an already-archived lane back to a file via `findOhMyPiBackgroundSessionPath` (archived lanes are invisible to the normal dashboard scan).
  - Tests: `tests/herdr-agent-hub-live.test.mjs`.

## Android portal (PR #19)
- `api/GatewayHub.kt` — hub models/parsers; `api/HerdrAgentStream.kt` — per-agent live transcript SSE.
- `api/VoiceAgentClient.launchSession` — generalizes hub/Colab launch presets into a free-form prompt/model/provider/cwd launcher.
- Standard flavor: new "Tasks" pane (`HubPortalComposables.kt`, ~560 lines) — lane -> subagent tree, per-lane chat and archive, general task launcher.
- Boox e-ink flavor: same launcher and per-lane chat/archive inline in the Hub peek, but no live stream (EPD ghosting makes continuous redraws the wrong tradeoff).

## Deliberate gap
`revive` is not wired into either UI: an archived lane can never appear in the tree it would be revived from. The client method exists for a future surface that tracks archived-lane names persistently.
