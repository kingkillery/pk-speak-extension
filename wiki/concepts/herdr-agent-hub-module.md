# herdr-agent-hub-* module (parallel to Android redesign)

Untracked TypeScript module observed appearing across passes 2-4 (2026-07-02), unrelated to the Android UI redesign. Backs `/v1/herdr/agent*` routes wired into `control-server.ts` (modified, +69/-… as of pass 4).

## Files
- `herdr-agent-hub-schema.ts` (103 lines) — "parse-not-validate boundary" for the routes. Defines branded `HubAgentId` (via `unique symbol` brand + `parseHubAgentId`), `HubAgentStatus` (`running | idle | parked | aborted`), `HubAgentKind` (`main | sub | advisor | background`), `HubFolder`, `HubAgent` interfaces.
- `herdr-agent-hub-gateway.ts` (294 lines) — gateway/binding layer; exports an `AgentHubBinding` type (referenced by the disk fallback) plus the live routing implementation.
- `herdr-agent-hub-disk.ts` (121 lines, new in pass 4) — `createDiskFallbackBinding(dashboardFn)`: builds an `AgentHubBinding` from the `agent-hub-dashboard` stale-while-revalidate scan when no live hub connection exists. `canMutate: false` — chat/kill/revive calls answer `409 hub_offline` in this mode.

## Interpretation
This looks like a resilience layer for the agent-hub API: a live gateway binding plus a read-only disk-scan fallback binding sharing the same `AgentHubBinding` interface, so `/v1/herdr/agent*` routes degrade gracefully to "list-only" when the hub is offline instead of failing outright.

## Status
Still in-flux and untracked as of pass 4 (2026-07-02) — no tests observed yet for this module. Re-verify shape once it stabilizes or lands in a commit; update this page rather than treating it as final.
