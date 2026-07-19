## 2026-07-14 - session: wt-001 conversational-assistant-pivot verification assist

- Added `sessions/2026-07-14-wt001-conversational-assistant-assist.md` — verified colleague worktree wt-001 (branch `advisor/001-conversational-assistant-pivot`, commit `e5e5d21`): build clean, 371/372 tests; fixed + committed the unrelated Windows `spawn-shim` EPERM teardown flake as `62dd2bd` (rmSync maxRetries/retryDelay). Recorded branch open items (README pivot WIP, skill-sync churn) and the sibling-worktree `git -C` / `npm --prefix` workaround.
- Linked from `wiki/index.md`. Direct-file writes (no Obsidian MCP write transport exposed this session).

## 2026-07-13 - concept: Agent Harness Design reading list

- Added `concepts/agent-harness-design.md` — curated reading list for the harness side of agentic systems (everything around the model: persistent execution, context governance, memory, skill routing, role coordination, supervision, runtime orchestration). Organized into three buckets — most relevant papers (Scaling the Harness in Agentic AI; Toward Executable, Verifiable, and Stateful Agent Systems; Interpreting Agentic Systems: Beyond Model Explanations; The Shift to Agentic AI: Evidence from Codex), benchmark and capability papers (Terminal-Bench, RE-Bench, Hierarchy of Agentic Capabilities, Forecasting Frontier Agent Capabilities), and practical harness engineering (philschmid 2026, Microsoft Agent Framework BUILD 2026, Claude context engineering cookbook). Includes a suggested reading order and a follow-up note about splitting into design/evaluation/safety buckets later. Cross-links to [[herdr-agent-hub- Module]] and the oh-my-pk fork snapshot.
- Linked from `wiki/index.md`.

# Wiki Log

## 2026-07-13 - sync: agent hub portal, voice benchmarks, oh-my-pk fork snapshot

- Rewrote `concepts/herdr-agent-hub-module.md`: module landed (`218ed8a`) and became an actionable Agent Hub portal via PR #19 (`819f6a2`) — live `AgentHubBinding` (chat/kill/revive), Android "Tasks" pane (`HubPortalComposables.kt`), e-ink inline chat/archive; disk fallback is now fallback-only; `revive` deliberately not surfaced in UI.
- Added `concepts/pk-speak-voice-benchmarks.md`: TTS/STT benchmark harness (`scripts/benchmark-{tts,stt}.ts`), Google Cloud STT provider, persistent voice hard-stop aliases, Boox e-ink cockpit redesign + `RealtimeTranscript.kt` delta coalescing.
- Added `syntheses/oh-my-pk-fork-2026-07.md`: remote-workspace Docker sandbox package vs environments-cloud (pkscloudenvs) SoT split, task-contract orchestration runtime, side-agent claim-fencing protocol, and uncommitted work (ompk-linear-agent Worker, /help recommender, multi-agent fork collaboration policy). Fork's own `.wiki/` remains SoT for fork internals.
- Note: `scripts/llm_wiki_save.py` crashed (`args.contradicts` NoneType iteration in `conflict_section`) and mangled the title slug ("herdr-agent-hub- Module"); notes were written via the direct-file fallback with manual index/log updates. Update (same day): both bugs are now fixed in `scripts/llm_wiki_save.py` (guarded `contradicts` loop in `conflict_section`; slug sanitization drops unsafe chars and normalizes hyphen/space artifacts, so `herdr-agent-hub-* Module` resolves to the existing `herdr-agent-hub-module` stem). Fix verified end-to-end against a temp vault; left uncommitted.

## [2026-07-13] save | herdr-agent-hub- Module
- Type: concept
- Location: wiki/concepts/herdr-agent-hub- Module.md
- Action: created
- Sources: pi-speak-extension PR #19 (819f6a2), herdr-agent-hub-live.ts

## 2026-07-02 - design: minimal connected-to-computer idle state

- User clarified the visual target after commit `4bbb3ea`: Android should feel more minimal/beautiful, like the OpenAI Codex mobile app connected to the computer, not merely a decomposed admin cockpit.
- Updated `DESIGN.md`, `Color.kt`, `StudioIdleState`, `StudioIdleStateScreenshotTest`, and the Roborazzi golden to reflect a quieter off-white + monochrome palette, centered connection glyph, "Connected to your computer" headline, compact Gateway/Target/Voice card, and shorter voice hints (`Hold to talk` / `Tap to talk`).
- Verified with `:app:testStandardDebugUnitTest --tests "com.example.StudioIdleStateScreenshotTest"`, recorded via `:app:recordRoborazziStandardDebug --tests "com.example.StudioIdleStateScreenshotTest"`, and visually inspected the new screenshot as PASS with minor non-blocking notes (glyph could become a more literal computer/device icon later).

## 2026-07-02T(pass6, final) - maintenance: Android redesign stable, wrapping watch loop

- State unchanged from pass 5: same `MainActivity.kt` diff (-3709/+540 vs base, +6 vs pass5 from our own wiki edits, no source drift), same `SessionsComposables.kt`/`SettingsComposables.kt`/`StudioComposables.kt`/`StudioIdleStateScreenshotTest.kt`/screenshot png, same `HeaderConnectionStateTest.kt` +3/-3 diff, `DESIGN.md` still untracked. No new commits beyond `218ed8a` (herdr-agent-hub landed at pass 5). Android redesign has now held steady across 3 consecutive passes (~15 minutes) with no further churn — concept pages (`android-design-system.md`, `studio-composables-structure.md`) should be reliable as-is for the main agent to reference.
- This is the final scheduled pass of this maintenance loop (6/6). Full outstanding cleanup list for the main agent, consolidated:
  1. **Untracked redesign files at risk**: `DESIGN.md`, `StudioComposables.kt`, `SessionsComposables.kt`, `SettingsComposables.kt`, `StudioIdleStateScreenshotTest.kt`, and `studio_idle_state.png` have been untracked (not even staged) for 25+ minutes — recommend `git add` soon to avoid accidental loss via `git clean` or similar.
  2. **Screenshot golden placement**: confirm `android-app/app/src/test/screenshots/studio_idle_state.png` is the intended committed-golden location (vs. needing a `.gitignore` entry for regenerated goldens).
  3. **Small test diff to double-check**: `HeaderConnectionStateTest.kt` (+3/-3) — likely a benign rename tied to the `HeaderSection` rework, but worth a quick confirm read since it's easy to overlook among the large composable-extraction diffs.
  4. **Dead-code sweep candidate**: after the Studio/Sessions/Settings extraction, do a pass over `MainActivity.kt` (2245 lines as of pass 3-6) for now-unused imports/helpers that used to be needed by the extracted composables but weren't cleaned up — not verified line-by-line this loop, just flagging the pattern risk.

## 2026-07-02T(pass5) - maintenance: herdr-agent-hub work landed, Android redesign still in-flight

- `git log` confirms the herdr-agent-hub module observed in passes 2-4 was committed: `218ed8a feat: expose agent hub through herdr gateway`, on top of `034680b fix: complete Android gateway parity follow-ups` and `6aae1ed feat: add herdr gateway controls`. `control-server.ts`/`herdr-agent-hub-*.ts` no longer show as modified/untracked — they're merged. `wiki/concepts/herdr-agent-hub-module.md` (written pass 4) is now documenting landed, committed code rather than in-flight work — good state, no changes needed.
- Android redesign side is unchanged since pass 3/4: same `MainActivity.kt` (-3709/+534 vs base), same `SessionsComposables.kt`/`SettingsComposables.kt`/`StudioComposables.kt`/`StudioIdleStateScreenshotTest.kt`/screenshot png, same `HeaderConnectionStateTest.kt` +3/-3 diff, `DESIGN.md` still untracked. This work has now been stable across 2+ passes (10+ minutes) — treat `wiki/concepts/studio-composables-structure.md` and `wiki/concepts/android-design-system.md` as accurate current-state docs, but they are still uncommitted in the working tree.
- Cleanup candidates carried over (still unresolved): (1) `android-app/app/src/test/screenshots/studio_idle_state.png` untracked golden — decide commit vs. gitignore; (2) `HeaderConnectionStateTest.kt` +3/-3 diff — confirm intentional; (3) `DESIGN.md` and the three new `*Composables.kt` files are still untracked (not just uncommitted-modified) after 20+ minutes — worth `git add`-ing soon so the redesign work isn't at risk of accidental loss (e.g. `git clean`).

## 2026-07-02T(pass4) - maintenance: herdr-agent-hub module now has a clear shape

- New untracked `herdr-agent-hub-disk.ts` (121 lines): `createDiskFallbackBinding(dashboardFn)` — read-only `AgentHubBinding` built from the agent-hub-dashboard stale-while-revalidate scan, used when there's no live hub (`canMutate: false`, mutating calls answer `409 hub_offline`). Combined with prior `herdr-agent-hub-schema.ts`/`herdr-agent-hub-gateway.ts`, the module now has enough shape to document — added `wiki/concepts/herdr-agent-hub-module.md` and linked it from `wiki/index.md`.
- Android redesign side unchanged since pass 3 (same MainActivity.kt/Sessions/Settings/Studio composable set, same diff stat modulo control-server.ts +1 line). No new concept-page work needed this pass on that front.
- Cleanup candidates carried over from prior passes (still unresolved, not verified further this pass): (1) confirm `android-app/app/src/test/screenshots/studio_idle_state.png` golden should be committed/tracked or gitignored; (2) confirm `HeaderConnectionStateTest.kt` +3/-3 diff is an intentional rename tied to `HeaderSection`, not a masked behavior change.

## 2026-07-02T(pass3) - maintenance: MainActivity.kt decomposition accelerates

- `MainActivity.kt` dropped sharply: 4941 → 2245 lines. Two new untracked composable files appeared: `SessionsComposables.kt` (~1776 lines: `SessionsTabContent`, gateway/ops/history panes, hub/Colab/collab launch flows) and `SettingsComposables.kt` (~1097 lines: `SettingsTabContent`, `WorkspaceFileViewerDialog`). Combined with earlier `StudioComposables.kt`, the redesign is generalizing a "one file per tab" extraction pattern — captured in `wiki/concepts/studio-composables-structure.md` (updated this pass).
- New untracked test artifact: `android-app/app/src/test/screenshots/studio_idle_state.png` — Roborazzi golden image for `StudioIdleStateScreenshotTest`. Cleanup candidate: confirm this generated screenshot path is meant to be committed (goldens usually are) vs. accidentally left untracked/uncommitted scratch output — main agent should decide whether it belongs in `.gitignore` or as a committed golden.
- `herdr-agent-hub-gateway.ts` / `herdr-agent-hub-schema.ts` / `control-server.ts` diff unchanged since pass 2 (+68/-… on control-server.ts) — still watching before writing a concept page for the herdr-agent-hub work.
- Cleanup candidate (carried over): confirm `HeaderConnectionStateTest.kt` +3/-3 diff is intentional.

## 2026-07-02T(pass2) - maintenance: redesign continues, new gateway hub files appear

- `git status`: MainActivity.kt diff grew (now -1239/+801, was -1151 net at pass1); wiki/index.md and wiki/log.md now show as modified (our own pass1 writes) — expected.
- New untracked: `android-app/app/src/test/java/com/example/StudioIdleStateScreenshotTest.kt` — Roborazzi screenshot test (Pixel8, sdk 36) for the `StudioIdleState` empty-state composable documented in `wiki/concepts/studio-composables-structure.md`. Confirms that composable is treated as a stable, testable UI surface.
- New untracked: `herdr-agent-hub-gateway.ts` (294 lines) and `herdr-agent-hub-schema.ts` (103 lines) — unrelated to the Android redesign; looks like new "herdr" agent-hub gateway/schema work (`/v1/herdr/agent*` routes, parse-not-validate boundary with branded `HubAgentId`, `HubAgentStatus`/`HubAgentKind` types). `control-server.ts` also modified (+68/-… lines), likely wiring these new routes in.
- No concept page added yet for the herdr-agent-hub work — feels early/in-flux (new files, no tests seen yet). Will watch next pass before writing a concept page; noting here so it isn't lost.
- Cleanup candidate: `MainActivity.kt` line count crept up between passes (4901 → 4941) even as the diff churn increased — worth a sanity check that extraction work is net-shrinking the file as intended once the redesign settles.


## 2026-07-02T(pass1) - maintenance: Android redesign in progress

- Observed via `git status --short` / `git diff --stat`: `DESIGN.md` added (new operator-cockpit design system doc); `android-app/.../StudioComposables.kt` added (new, untracked) extracting Studio-tab composables out of `MainActivity.kt`; `MainActivity.kt` modified (net -1151 lines, -1746/+601 diff stat) as composables move out; `HeaderConnectionStateTest.kt` modified (+3/-3), likely a small follow-up for the `HeaderSection` rework.
- Added `wiki/concepts/android-design-system.md` capturing the DESIGN.md token/palette/typography/spacing contract and named components (`HeaderSection`, `PiSpeakDrawer`, `StudioTabContent`, `ConnectionErrorBanner`, `GatewaySessionRow`).
- Added `wiki/concepts/studio-composables-structure.md` mapping the composable tree in the new `StudioComposables.kt` (`StudioCockpitLayout` → status strip / conversation panel / composer), including the new `StudioIdleState` empty-state composable.
- Cleanup candidate: `MainActivity.kt` is still ~4901 lines after the StudioComposables extraction — likely more extractable sections remain (not verified line-by-line; flagging for main agent to consider further splitting once the redesign stabilizes).
- Cleanup candidate: confirm the `HeaderConnectionStateTest.kt` +3/-3 diff is a deliberate rename tied to `HeaderSection` rework and not a masked behavior change — small enough to be easy to miss in review.

## 2026-07-02 - session: PR 13 Android gateway parity completion

- Added `wiki/sessions/2026-07-02-pr13-android-gateway-parity.md` summarizing the PR #13 merge, GPT subagent review, valid follow-up fixes, skipped findings, validation evidence, and subagent cleanup.
- Updated `wiki/overview.md` and `wiki/index.md` so the current Android gateway parity state is discoverable.
- Used direct filesystem writes because no Obsidian MCP write/read tools were exposed in this session.

## 2026-07-02 - vault: oh-my-pk harness rebrand note

- Added the project note `Projects/pi-speak-extension/OH_MY_PK_HARNESS_REBRAND.md` in `C:\dev\Desktop-Projects\Helpful-Docs-Prompts\VAULTS-OBSIDIAN\designandbuilding-vault`.
- Used direct filesystem writes because Obsidian MCP transport was unavailable in this session.
- Recorded the canonical `oh-my-pk` / `ompk` harness naming, compatibility aliases, verification results, and ADB device status.

## 2026-05-07 - skill: installed map-codebase in pk-skills1

- Installed `map-codebase` under `C:\Users\prest\.agents\skills1\pk-skills1`.
- Mirrored the skill to Codex, Pi, Claude, agent, and Helpful-Docs-Prompts skill targets through `managed-skill-sync`.
- Refreshed `~/.codex/skill-index.md` so the skill is discoverable by name, tags, and examples.

## 2026-05-07 - docs: codebase map and remote parity updates

- Added `docs/CODEBASE_MAP.md` as a source-backed architecture and runtime-flow map.
- Updated `wiki/overview.md` for Pi/Codex provider parity, shared remote auth, Android connection modes, Telegram runtime setup, and Bluetooth local-link onboarding.
- Updated validation and README pointers so current remote behavior is discoverable from the codebase docs.

## 2026-05-06T23:20:00Z - decision: tailscale IP-only identifiers

- Recorded preference to reference Tailscale IPs only, not local-network identifiers.
- Required mappings: appserver `100.76.136.91`; jims-mac-mini (mac) `100.76.176.119`; pixel 9a `100.72.61.52`.
- Added app requirement: phone app should make both Mac and MSI/appserver connections available as selectable machine targets.

## 2026-05-06T22:32:59Z - skill: saved `skill-llm-as-a-verifier-cli-skill`

- validation: validated (33)
- kind: workflow
- brief refs: .llm-wiki/skill-pipeline/briefs/20260506-223259--llm-as-a-verifier-cli-skill.md

## 2026-07-13 - history: committed changes through 2026-07-13

- Added [Recent History — 2026-06/07](syntheses/recent-history-2026-06-07.md), filling the June implementation gap and connecting the existing July concept pages to the committed source history (`81f2c88..5199341`).
- Used direct-file fallback because no Obsidian wiki write transport was exposed; preserved the existing uncommitted wiki/script edits and did not edit raw sources.
