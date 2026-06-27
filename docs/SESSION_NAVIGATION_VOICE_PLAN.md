# Session Speed, Navigation & Voice-Control Plan

Status: SCOPING (awaiting approval before further implementation)
Owner: pi-speak-pk gateway / agent-hub
Last updated: 2026-06-27

This plan covers three linked workstreams the user requested, in priority order:

1. **Speed** — make `/v1/sessions` (the dashboard the Boox/phone Hub polls) at least 10x faster.
2. **Navigation** — workspace-grouped, well-named sessions with natural 24h+ archiving (recoverable, stored locally) so ongoing work is easy to move between.
3. **Voice** — control omp agents/sessions by voice at parity with the GUI (navigate, switch, send turns, launch, archive/recover).

Primary constraint from the user: **oh-my-pi (omp) background agents are the primary connection / function of the app.** The dashboard, navigation, and voice surfaces must treat omp lanes as first-class, not an afterthought.

---

## 0. Current-state findings (grounded in code, 2026-06-27)

Measured baseline of `/v1/sessions` (warm FS cache): ~3.8–6s; cold first call observed at 31s.

Per-component attribution (microbenchmark on this machine):

| Component | Cost | Notes |
|---|---|---|
| `sm sessions list --json` (claude sessions) | **2793ms** | spawns the `sm` CLI which does its own heavy scan |
| `powershell Get-CimInstance Win32_Process` (running agents) | **945ms** | PS cold start + WMI enumeration |
| codex jsonl scan (`~/.codex/sessions`) | 48ms | native, fine |
| **omp background scan** (`buildOhMyPiAgentHubDashboard`) | **2192ms** | reads **all 195 jsonl, 261.8MB** in `~/.omp/agent/sessions/<slug>/*.jsonl`; only 11 are background lanes |

Critical correctness gap discovered while scoping:

- **The headless gateway's `buildRecentSessionDashboard` never calls `mergeOhMyPiAgentHubSessions`.** So over Tailscale (the primary app path), the dashboard currently **omits omp background agents entirely** — the app's core function is missing from the network surface. This must be fixed as part of the speed work, not deferred.

Architecture facts:

- Two entrypoints wire DIFFERENT handler sets: `index.ts` (in-terminal extension) wires the full set; `headless-gateway.ts` (the Tailscale process) wires a subset. (Launch was just added; dashboard merge + rename/remove are still index-only.)
- `discoverAgentInventoryCached` TTL = 2000ms; expires before each poll, so nearly every request re-scans.
- omp sessions live under `~/.omp/agent/sessions/<project-slug>/<timestamp>_<uuid>.jsonl`; the session header (record 0) carries `backgroundInstance` for the 11 active lanes. `cwd` is on the header.
- `archiveOhMyPiBackgroundSession` already exists: it flips `backgroundInstance.status` to `"archived"` in-place (no file move) and appends an `archived` `background_instance` record. **Recovery is therefore just flipping status back to `active`** — no separate archive store needed for omp lanes.
- `SessionDashboardEntry` has no `workspace`/`archived` fields yet.
- Voice: `parseVoiceSlashCommand` already maps utterances ("switch to X", "new session Y", "list sessions", "remove session Z") to `/sess` commands — but only in the in-terminal extension. The headless/phone voice path routes *turns*, not session-management commands.

---

## PHASE 1 — Speed (target: 10x; ≤380ms warm, ≤3.1s cold)

### 1.1 Replace `sm` subprocess with native claude scan  [DONE in working tree]
- Added `discoverClaudeRecentSessions` + `readClaudeSessionMeta` (scans `~/.claude/projects/**/*.jsonl`, reads bounded prefix for `cwd`/`sessionId`).
- Native scan measured **144ms vs 2793ms** (~19x on that component).
- Removed dead `discoverRecentAgentSessions` (`sm` spawn).

### 1.2 Stale-while-revalidate cache  [DONE in working tree]
- `discoverAgentInventoryCached`: returns last snapshot instantly; schedules an async refresh via `setImmediate` when stale; first-ever call blocks; `ttlMs <= 0` still forces a blocking fresh scan (preserves resume-resolution correctness).

### 1.3 Make the omp background scan prefix-first  [IN PROGRESS in working tree]
- `parseBackgroundSessionFile` was reading whole transcripts (261.8MB total). Change to:
  - Read a bounded **prefix** (256KB) for the header (record 0). Reject non-background sessions after the small read.
  - Only when the header lacks `backgroundInstance` (older sessions), read a bounded **tail** (256KB) for the appended `background_instance` record.
- Add `readFilePrefixBytes` / `readFileTailBytes` helpers; retire whole-file `safeReadText` from the hot path.
- Expected: 2192ms -> low tens of ms (11 small reads + 184 single-prefix rejects).

### 1.4 Wire omp merge into the headless dashboard  [REQUIRED — currently missing]
- `buildRecentSessionDashboard` (headless-gateway.ts) must call `mergeOhMyPiAgentHubSessions(dashboard)` so omp lanes appear over Tailscale.
- Apply the same stale-while-revalidate caching to the omp dashboard build (cache the merged result; refresh in background) so the merge does not re-introduce latency.

### 1.5 Verify
- Re-run latency loop against `/v1/sessions`: assert warm ≤380ms and cold ≤3.1s (10x of 3.8s / 31s respectively).
- Assert omp background lanes are present in the JSON (count matches `buildOhMyPiAgentHubDashboard`).
- `npm test` + targeted `node --test tests/agent-hub-*.test.mjs`.
- Add/extend a test asserting prefix-first parse still finds the 11 lanes and rejects non-background sessions.

Acceptance: `/v1/sessions` ≥10x faster AND includes omp background agents.

---

## PHASE 2 — Navigation (workspace grouping + natural archiving)

### 2.1 Workspace grouping
- Add `workspace?: string` to `SessionDashboardEntry`, derived from `cwd` (the project root / its basename). omp lanes already carry `cwd`; codex/claude meta carry `cwd`.
- Group in the dashboard payload: either (a) add a `workspaces: { workspace, sessions[] }[]` view alongside the flat `sessions[]`, or (b) sort+tag flat entries by workspace. Prefer (a) for the Hub UI; keep flat list for backwards compatibility.
- Decision needed: derive workspace label from full `cwd` path vs basename. Default: basename for display, full path as the grouping key (avoids collisions like two `dist` dirs).

### 2.2 Natural archiving (stale > 24h, recoverable, local)
- Define "stale": `lastActivity` (mtime) older than 24h AND not the current/active routed session.
- omp lanes: reuse `archiveOhMyPiBackgroundSession` (flips status to `archived`, in-place, local). Recovery = new `recoverOhMyPiBackgroundSession` that flips status back to `active`.
- codex/claude: no in-file status; archiving = move the jsonl to a sibling `archive/` dir under the same root (recoverable by moving back), OR record archived paths in the routing store. Decision needed (see Open Questions). Default: a local `<root>/archive/` move with an index file for recovery, since it is uniform and obviously local + reversible.
- Auto-archive trigger: a periodic sweep (e.g. on dashboard refresh, rate-limited to once/hour) that archives stale lanes. Must be OFF by default or clearly gated until the user confirms the policy, to avoid surprising archival of active work.
- Dashboard surfaces `archived` entries in a separate group; Hub can show/recover them.

### 2.3 Endpoints
- `POST /v1/sessions/archive { sessionPath }` and `POST /v1/sessions/recover { sessionPath }` on BOTH index.ts and headless-gateway.ts (parity).
- Capabilities advertised in `/v1/status` and discovery.

### 2.4 Verify
- Unit tests: archive then recover round-trips an omp lane (status active -> archived -> active); stale detection respects the 24h boundary and never archives the current session.
- Confirm archives are readable/recoverable from local disk only.

Acceptance: sessions are grouped by workspace; stale (>24h) sessions can be archived and recovered locally; the active session is never auto-archived.

---

## PHASE 3 — Voice control of omp sessions (GUI parity)

Depends on the deep-research output (see `docs/VOICE_COMPUTER_USE_RESEARCH.md`, produced by the `VoiceControlResearch` agent) for the intent-parsing approach. Scope below is the integration regardless of which engine wins.

### 3.1 Command surface (parity with GUI actions)
Voice must reach every Hub action:
- list sessions / list by workspace
- switch active session (by name or workspace + index)
- send a turn/prompt to a chosen session
- launch a new omp agent (hub or with prompt)
- archive / recover a session

### 3.2 Intent path
- Reuse the wake word ("PK") + existing STT.
- Extend `parseVoiceSlashCommand` (or add a gateway-side equivalent) so the **headless/phone** voice path can issue session-management commands, not just turns. Today that parser is only wired in the in-terminal extension.
- For robust natural phrasing, layer LLM function-calling (Whisper transcript -> intent schema -> gateway endpoint) as the fallback when grammar match fails. Final engine choice pending research.

### 3.3 Endpoints / wiring
- Map intents to existing endpoints: `/v1/sessions`, `/v1/sessions/launch`, `/v1/turn/text`, plus new `/v1/sessions/archive|recover`, and a switch/route endpoint (`setRoutingTarget` exists on the gateway).
- Confirm mic origin constraints (HTTPS via Tailscale Serve) for the Boox/phone browser path.

### 3.4 Verify
- Voice utterance -> correct endpoint call for each GUI action, tested via the spoken-command parser unit tests and a gateway integration test that feeds transcripts and asserts the resulting action.

Acceptance: every GUI session action is reachable by voice; omp lanes controllable hands-free.

---

## Resolved decisions (user, 2026-06-27)

1. **Auto-archive**: a once-per-DAY sweep (not hourly) archives sessions stale 24h+ without use. The current/active routed session is never swept.
2. **codex/claude archive mechanism**: track-and-hide in the routing store (record archived paths, hide from dashboard; no file moves; fully reversible).
3. **Workspace label**: basename for display, full `cwd` path as the grouping key.
4. **Voice engine** (resolved via research, see `docs/VOICE_COMPUTER_USE_RESEARCH.md`): Boox/Android = **Gemini Live** (already wired) with `FunctionDeclarations`; optional **Vosk grammar** fast-path on the Windows host; open-ended prompt dictation via faster-whisper -> Gemini Flash function-call. Confirm before building Phase 3.
5. **Sequencing**: finish Phase 1 (speed + omp merge) now, report results, then review before Phases 2–3.

---

## CHANGELOG
- 2026-06-27 (initial): Scoping created; Phase 1 partially implemented; deep-research agent dispatched.
- 2026-06-27 (Phase 1 COMPLETE + VERIFIED): 1.1–1.5 done. `/v1/sessions` measured **31s/~4s -> 1.9s cold / 56–64ms warm (~10–65x)**; **11 omp background lanes now present over Tailscale** (were absent). Native claude scan replaced `sm` (144ms vs 2793ms); omp scan prefix-first (2192ms->592ms); stale-while-revalidate caching on inventory + omp dashboard; merge wired into headless `buildRecentSessionDashboard`. All 286 tests pass + new prefix-first regression test. Voice research complete; engine decision recorded. Phases 2–3 pending review.
- 2026-06-27 (Phase 2 COMPLETE + VERIFIED): workspace grouping (`workspace`/`workspaceKey`/`workspaces[]`), 24h stale flagging, `POST /v1/sessions/archive {action}` (omp in-file flip via archive/recover helpers; codex/claude track-and-hide via `archivedPaths` in the routing store), once-per-day `runStaleSessionSweep`, and `enrichDashboardWithWorkspaces` wired into the headless dashboard. Live-verified: 8 workspace groups, 10 stale flagged, archive hides + recover restores a real claude session. 6 new navigation tests; 293 total pass.
- 2026-06-27 (Phase 3 COMPLETE + VERIFIED): voice GUI parity via the realtime `/v1/live` Gemini Live path. Added `list_sessions`/`launch_agent`/`archive_session` FunctionDeclarations + dispatch handlers alongside the existing `switch_session`/`get_session_info`/`execute_terminal_command`, all routing to the same ControlServer handlers as the HTTP/GUI surface. KEY REALIZATION: function-calling runs in the gateway's Live connection, so the Boox client needs NO rebuild for the voice intent path (it already streams mic to `/v1/live` via `RealtimeVoiceClient`). Engine-agnostic fallback: `parseVoiceSlashCommand` extended to archive/recover/launch/launch-hub/list-workspaces. Verified: `/v1/live` WS opens + initializes a Gemini Live session with all 6 tools, no error; archive endpoint (3 tests) + voice parser (6 intents) covered; 296 total pass. Optional future: a Vosk local-grammar fast-path on the Windows host (per research) for sub-200ms discrete commands — not required for parity.
