# Web Remote v6 Proposal — Recovery, Approvals, and Supervision

Date: 2026-07-19 · Status: reviewed implementation proposal (no product source changed)

Surface: `web/remote/index.html`, `web/remote/app.js`, `web/remote/sw.js`, and the narrow control-server/realtime contracts required by the web client. The remote remains a zero-dependency PWA paired with, but not visually governed by, the Android app.

## Decision

Pi Speak is an operator supervision surface, not a consumer chat clone. Claude and ChatGPT remain useful interaction references, but their history drawer, hidden operational state, rich message actions, and full-screen voice treatment are not product requirements.

**v6 has exactly three release findings:**

1. typed authentication recovery plus browser credential/transport hardening;
2. reconnect-resilient approval ownership, replay, expiry, resolution, and audit for approvals created by live turns; and
3. mobile supervision and structural accessibility while retaining the existing primary tabs and initializer DOM.

Palette convergence, a composer rewrite, rich messages, per-message audio, Retry, a voice overlay, `?v=5` retirement, and broad information-architecture replacement are explicitly outside the v6 release scope. Their source-backed observations are retained in the follow-up register rather than being presented as committed work.

---

## 1. Why invest in the web surface

Android is the richer installed client, but it cannot replace the web remote's zero-install recovery path, desktop/browser access, setup QR destination, or PWA fallback on devices where the app is unavailable. The highest-value web work is therefore browser-specific risk reduction, not Android visual parity:

- a browser can retain a rejected token while hiding the replacement UI;
- `EventSource`, browser `WebSocket`, URL history/referrers, and Cache Storage create credential and reconnect failure modes that do not exist in the Android client;
- live approvals are currently delivered only to the attached live WebSocket and need a web-reachable replay/resolve path; and
- a phone browser must expose session, route, queue, event, and approval state without imitating a consumer history drawer.

This release is justified as safety and recovery work for an already-supported control surface. Further visual investment requires evidence of web use (for example, paired active web clients, recovery attempts, and approval resolutions) collected as privacy-preserving counts with no token, command, prompt, path, or message content. No analytics system is required to ship v6.

### Measurable web release outcomes

| Outcome | Current baseline | v6 gate | How to measure |
|---|---|---|---|
| Rejected-token recovery | `syncLockedUi()` equates “has token” with “authorized”; a 401 changes pill copy while the token form remains hidden. | Missing, rejected, unreachable, reconnecting, and connected states are distinguishable. From a current-epoch 401, replacement is immediately actionable and a valid token reaches `Connected` within 60 seconds without host-side intervention. No rejected credential continues a retry loop. | Connection-reducer tests plus a timed browser scenario for each state and stale-response race. |
| Credential containment | The setup link, SSE, and live WS can put the long-lived bearer in query strings; the service worker caches `/app/` requests by the original request URL. | No long-lived bearer appears in request URLs, browser history after bootstrap, referrers, server access URLs for streams, or Cache Storage. A cache inspection after legacy-link migration contains no token-bearing key. | Integration tests for setup, SSE, WS, service-worker upgrade, headers, Origin rejection, and cache keys. |
| Live-turn approval reachability | Pending terminal/command approvals live in an `ActiveSession`, are sent over its WS, expire after about 60 seconds, and have no HTTP snapshot. `/v1/events` currently carries no approval lifecycle. | During the server-side approval lifetime, a live-turn approval is visible within one snapshot/event cycle after reload or transport reconnect, resolves exactly once, exposes server-time expiry, and leaves an approved/rejected/expired/execution result audit state. | Integration tests for both approval kinds, reload/reconnect, session loss, expiry, duplicate/conflicting decisions, and one execution. |
| Mobile supervision/accessibility | The primary Chat/Sessions tabs exist, but connection/route/approval state is fragmented; click-only rows and whole-chat live announcements impede keyboard and assistive use. | From Chat, connection, active target, busy/queue state, and pending count are visible without navigation; the existing Operations surface is one primary-tab action away. All affected controls work by keyboard/touch/SR at 320–430 px and desktop widths, with one announcement per state transition and no iOS focus zoom. | Keyboard and screen-reader smoke, automated semantic/contrast checks, and responsive interaction tests. |

---

## 2. Audit method and selective precedent

The [ibelick/ui-skills](https://github.com/ibelick/ui-skills) material is used as an audit discipline, not as a binding stack or design system. In particular:

- `improve-ui` supplies the Contract → Runtime → Correction proof gate and the maximum-three-findings discipline;
- `fixing-accessibility` supplies semantic, focus, announcement, contrast, zoom, and motion checks;
- `baseline-ui` and `fixing-motion-performance` remain useful for later visual work;
- Tailwind, React, Base UI/Radix, and consumer-chat navigation are not imported into this vanilla PWA; and
- root `DESIGN.md` explicitly describes the Android app. Sage & Clay and its no-gradient guidance are directional references for web, not a binding web contract. Validated web operator outcomes and WCAG requirements win.

Useful consumer-chat observations are deliberately filtered:

| Reference observation | Pi Speak disposition |
|---|---|
| Keep Stop close to the active turn. | Retain. Stop remains directly reachable; v6 does not rewrite its behavior. |
| Show tool activity near the conversation. | Only after server-backed approval replay exists. v6 keeps an always-reachable pending region rather than claiming placement solves delivery. |
| Put history and operations in a drawer. | Reject for v6. Pi Speak's route, queue, events, and approvals are supervision state, not consumer history. Keep the existing primary tab. |
| Use a single morphing composer and message action rows. | Defer. The current DOM/stream/audio models do not support this as a restyle. |
| Use rich Markdown assistant documents. | Defer. The current `textContent` path is a valuable XSS invariant. |
| Use full-screen live voice entered by long-press. | Defer. This lacks browser audio-transport and accessibility support and can hide approvals. |
| Match Android's palette and theme behavior. | Defer pending a web-specific contrast/usability validation; it is not a release outcome. |

---

## 3. Release findings (maximum three)

| # | Problem and source evidence | Deterministic correction | Confidence |
|---|---|---|---|
| R1 | **Authentication is presence-based and browser credentials leak into transport URLs.** `app.js` derives lock state from a non-empty token, handles `apiFetch()` 401 only as copy, schedules an untracked SSE retry, and cannot read an SSE/WS handshake status. `buildRealtimeWebSocketUrl()` and `startEventStream()` add the bearer to URLs. Setup emits `/app/?token=…`; `sw.js` can cache that request key. `control-server.ts` treats loopback as authorized and omitting CORS response headers as sufficient rejection. | Add a credential-epoch connection reducer; classify opaque stream failures with an authenticated status probe; cancel stale work; replace long-lived query credentials with a fragment bootstrap and short-lived scoped stream tickets (or authenticated fetch-stream SSE); harden service-worker caching, Origin/fetch-site checks, mutation auth/methods, response headers, and CSP. | High |
| R2 | **Live-turn approvals are bound to one `ActiveSession`/WS and are not replayable.** Terminal and command registries plus their pending execution continuations live on `ActiveSession`; records are deleted on resolution/expiry; IDs are sequential; `/v1/events` does not receive approval events. A presentation-only card move cannot repair this. | Add one narrow, process-local realtime approval bridge over both existing registries and their frozen pending continuations. Expose authenticated snapshot and atomic resolve contracts, correlated lifecycle events, bounded tombstones, explicit server-time expiry, and recent audit states. Retain/locate the owning live session and call the existing resolve path rather than creating a second execution registry. | High |
| R3 | **Mobile supervision and structural accessibility are fragile.** Replacing the tab bar would orphan `switchTab()` initialization of sessions, agents, workspace, and SSE. The large `els.*` selector map contains optional/stale bindings; session rows are click-only, while agent controls still need explicit selected/current semantics. The whole chat is `aria-live`, approval rendering clears/rebuilds a live region, and the textarea is 15 px. | Retain Chat + Operations as primary tabs and their required IDs. Add a compact supervision strip, make lifecycle bootstrap state-driven, add fail-fast selector parity, native session-row controls and complete tab semantics, use dedicated announcement nodes, raise text entry to 16 px, and display the canonical target/workspace context returned by the server. | High |

---

## 4. v6 scope and non-goals

### In scope

- `web/remote/app.js`: connection reducer, credential epochs, status probe, stream-ticket lifecycle, approval snapshot/event reducer, event cursor, supervision state, accessible rendering, and teardown.
- `web/remote/index.html`: recovery/status/approval semantics, retained primary tabs/required IDs, compact supervision strip, CSP-compatible bootstrap, and 16 px text entry.
- `web/remote/sw.js`: atomic shell upgrade and public-shell-only cache rules.
- `control-server.ts`: stream-ticket mint/consume, strict browser Origin boundary, authenticated approval snapshot/resolve routes, no-store/referrer/CSP headers, mutation method/auth hardening, and server-resolved context responses.
- Realtime approval modules: cryptographic IDs, owner/correlation metadata, a narrow list/resolve bridge, bounded tombstones, and lifecycle/audit emission while preserving the existing approval-gated execution path.
- Focused unit/integration/browser tests for the three release findings.

### Explicit v6 non-goals

- no Claude/ChatGPT-class visual parity claim and no Android UI changes;
- no broad sidebar, drawer, `+` menu, overflow menu, settings-sheet, or workspace relocation;
- no deletion or retirement of the current tab bar, dock, `.v5-controls`, live route/settings/refresh controls, or `?v=5` compatibility variant;
- no composer morph, recording waveform, new recording cancel semantics, textarea autosize claim, voice-toggle move, or preservation-sensitive draft rewrite;
- no full-screen voice overlay, waveform/orb, long-press-only entry, or new browser live-audio mode;
- no Markdown/rich HTML, per-message action rows, per-message audio, Copy/Retry controls, suggestion chips, or tool-progress row;
- no manual theme, palette convergence, skeleton-loading pass, radius/type cleanup, or manifest redesign; and
- no claim that an approval survives gateway process restart or expiry of its owning live session. Process restart/session loss closes pending work without execution and leaves/recovers an expired audit tombstone where metadata was persisted.

---

## 5. v6 contracts

### 5.1 Typed connection reducer

Use one application state source rather than deriving authorization from form values or token presence:

```text
Connecting | Connected | TokenMissing | TokenRejected | Unreachable | Reconnecting
```

- Initial boot without a credential enters `TokenMissing`. With a credential, it enters `Connecting` and probes authenticated `/v1/status`; the token is not considered valid until that probe succeeds.
- Every authenticated request and stream attempt captures a monotonically increasing **credential epoch**. Only a 401 associated with the current epoch may enter `TokenRejected`; only a successful current-epoch probe may enter `Connected`.
- `apiFetch()` and direct authenticated audio fetches route 401 through the reducer. Browser `EventSource` and `WebSocket` do not expose handshake status reliably, so their error/close first enters `Reconnecting` and triggers the authenticated status probe. Only that probe's 401 means `TokenRejected`; network errors and 5xx remain `Unreachable`/`Reconnecting`.
- Entering `TokenRejected` aborts outstanding authenticated fetches, closes SSE/WS, invalidates stream tickets, clears audio requests, and cancels/guards every scheduled reconnect. A late response from an older epoch cannot relock or unlock the UI.
- **Save and reconnect** increments the epoch, preserves typed drafts, remember-token preference, route/session choices, and unrelated settings, then probes immediately. Failure keeps the recovery form available; success invokes one epoch-guarded `startAuthenticatedChannels` orchestrator. In Phase 0 it owns the ticketed event channel; the live WS remains lazy/on-demand unless resuming a known live session.
- On the transition to `TokenRejected`, announce the error once with `role="alert"`, reveal a labelled recovery region, and move focus once to its heading or token field. Associate help/error text through `aria-describedby`; repeated retries never steal focus.
- `TokenMissing` and `TokenRejected` render an explicit recovery heading, error/help text, token field, remember choice, and Save/reconnect action—not a blank or merely color-coded locked shell. Unavailable operations are hidden/inert and removed from the tab order. `Unreachable` never asks the user to replace a token.
- The persistent auth label remains. It reports authorization (`Connected`, `Token rejected`, and so on), not “token loaded.” Status/error copy is also published once through the dedicated status/alert node in §5.4.

### 5.2 Browser credential and control boundary

Long-lived bearer tokens must never be routine URL credentials.

1. **Bootstrap:** every client-consumed setup handoff uses a fragment; new browser links use `/app/#token=…`, read the fragment into session storage, and remove it with `history.replaceState` before other initialization. When the server must consume setup authorization, use a cryptographically random, short-lived, single-use setup ticket instead of the bearer. Legacy `/app/?token=` and `/setup?token=` links share one bounded compatibility window, immediate scrub/exchange, non-cache rule, and migration test. Session storage is the default; local persistence remains an explicit “Remember token” choice.
2. **Fetch APIs:** authenticated JSON/audio requests use `Authorization: Bearer`. Disable `PI_SPEAK_HTTP_ALLOW_QUERY_TOKEN_FOR_AUDIO` for long-lived bearers in v6; any URL-compatible audio fallback must use a short-lived, single-use, audio-scoped ticket. Authenticated/control responses send `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
3. **SSE/WS:** mint a cryptographically random, short-lived, single-use, channel-scoped (`events` or `live`) stream ticket through an authenticated POST. Put only that ticket—not the bearer—in the handshake query. Close `EventSource` on error and mint a fresh ticket after the status probe; never reuse a consumed ticket. An authenticated fetch-stream implementation for SSE is an acceptable alternative. Token replacement/rejection invalidates every outstanding ticket.
4. **Service worker:** bump the cache version, install a same-release shell including `/app/app.js`, and delete old caches only after the new shell installs. Cache only an explicit public-shell allowlist under canonical query-free keys. Never cache a request with search parameters, authorization, a control/API path, or an authenticated response. A transient network failure must not combine new HTML with stale JS.
5. **Browser request boundary:** CORS is not authorization. Before route dispatch, reject browser Origins that are neither same-origin nor explicitly allowlisted, reject `Sec-Fetch-Site: cross-site` on control routes, and validate Origin on `/v1/live` upgrades. Non-browser clients without Origin still require bearer authentication.
6. **Loopback/CSRF:** loopback, Host, or Tailscale address trust alone must not authorize browser mutations. Mutations require the bearer or a same-origin CSRF-bound session and are POST-only. Retiring side-effecting `GET /v1/turn/text` is an explicit breaking route change in the same release: update the discovery descriptor, web/non-browser clients, operator docs, and compatibility tests; do not retain a browser-origin GET mutation. The public app shell/setup and any intentionally public health/pairing route remain narrowly enumerated.
7. **Content boundary:** all message, tool, event, workspace, target, and approval strings are untrusted. v6 preserves DOM construction plus `textContent`/`replaceChildren()` and prohibits raw HTML rendering. Serve `/app/*` with a restrictive CSP (`default-src 'self'`, same-origin script/connect including the exact same-origin WS endpoint, `media-src 'self' blob:`, `worker-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`). Move, hash, or nonce the current inline bootstrap; account explicitly for the current inline stylesheet. Injection regression tests use hostile strings in every rendered channel.
8. **Server-authoritative context:** treat every browser path, manual target, and persisted value as an untrusted hint. For browser-supplied launch cwd, v6 chooses confinement: on every workspace read or launch, canonicalize the real path, require the intended file/directory under `PI_SPEAK_WORKSPACE_ROOT`, and reject out-of-root, stale, symlink/junction escape, or wrong-type values rather than clamping. A future separately named privileged launch-path capability needs its own allowlist and approval contract.
9. **Dispatch target:** resolve route/agent IDs at dispatch against the live authorized registry/grammar, including `herdr` targets; reject unknown/stale IDs and return the canonical server-resolved target/path. Approval context is derived from that resolution, never from client display data.

### 5.3 Reconnect-resilient live approval contract

“Reconnect-resilient” means UI-mode, page, SSE, and browser-WS reconnects during the approval's server lifetime. It does **not** mean executable work survives process restart, the owning Gemini session closing, or server-time expiry.

#### Ownership

- Introduce a narrow gateway-owned `RealtimeApprovalBridge` shared with `ControlServer`. It indexes both terminal and command approvals to their owning `ActiveSession` and frozen pending continuation; it does not create a second client-driven execution registry.
- An immutable server record contains: cryptographically opaque `id`, approval kind, live-session ID, turn/correlation ID when available, tool-call ID/name, canonical command or description, frozen execution payload/plan reference, server-resolved cwd/target, `requestedAt`, `expiresAt`, decision status, execution status, and audit/event sequence.
- Snapshot/event projections omit the frozen payload, credentials, environment, and other secret material; they expose only the display-safe canonical summary and server-resolved context needed for an informed decision.
- Client-provided display strings, cwd, target, or payload never select what executes. Approve invokes the already-stored continuation once through the existing resolver. Reject and expiry never execute it.
- Existing WS approval messages remain compatibility inputs but call the same bridge transition as HTTP; no path may bypass the atomic state machine.
- v6 explicitly keeps the gateway's single-operator trust domain: every configured primary or extra token is an equivalent supervisor allowed to list/resolve all live approvals. After validation, the server maps the credential to a stable non-secret key identifier and records that identifier as the decision actor. Remote address, client ID, approval-ID possession, and displayed session context are never authorization. Per-token approval isolation would require a separate scoped-auth design.

#### HTTP and event surface

- `GET /v1/approvals` returns pending records, bounded recent tombstones, server time, and an approval-event cursor.
- `POST /v1/approvals/:id/resolve` accepts only `{ "decision": "approve" | "reject" }`.
- The atomic transition is `pending → approved | rejected | expired`. An approved record separately exposes `execution: pending | running | succeeded | failed` so “approved” is not confused with “succeeded.”
- A duplicate identical decision returns the recorded result without re-execution. A conflicting decision returns 409. Server-time expiry returns 410. Unknown/owner-gone returns 404 or a retained expired tombstone, never execution.
- Retain terminal tombstones long enough for response-loss retries and the advertised event replay window (minimum: the greater of the approval TTL and 10 minutes). Persist display-safe pending metadata and audit tombstones; restart converts pending records to expired/non-executable tombstones. Frozen payloads and continuations are never persisted or reconstructed from client/audit data.
- Publish `approval.requested`, `approval.resolved`, `approval.expired`, and `approval.execution` records into `/v1/events` with stable IDs/status and no bearer. This is a new contract; the route does not carry approval lifecycle today.
- Phase 1 extends `startAuthenticatedChannels` to hydrate the approval snapshot and cursor barrier first, then open `/v1/events?since=<cursor>` so changes between snapshot and subscription replay. Store the highest received `event.seq`, never `eventLog.length` (the log is capped and `since` is an opaque monotonic cursor).
- The client derives a clock offset from snapshot `serverTime`, disables decisions when `expiresAt` is reached, marks the card “checking expiry,” and refreshes the snapshot. Client time never extends validity; the resolve response remains authoritative.

#### Presentation and language

- Phase 1 renders snapshot-backed cards in the existing pending region before any optional relocation. A recovered card is not falsely attached to a message; “at originating turn” requires a stable correlation plus a turn view-model and is deferred.
- Each pending card shows **Requested by live turn**, session/turn when known, tool/operation kind, canonical command/description, server-resolved target/cwd, request time, and expiry. Buttons are **Approve and run** and **Reject — do not run**. “Not now” is prohibited because rejection is permanent.
- A resolved card becomes a read-only approved/rejected/expired/execution result state and remains available in the bounded recent/audit view instead of vanishing. The persistent pending-count control opens/focuses the pending region.
- The card list and pending chip are not separate live regions. New live requests announce once (assertive), hydrated state announces once as “N approvals waiting” (polite), and resolution/expiry announces once. Rebuilding or hydrating the card list must not repeat each item.

### 5.4 Mobile supervision and accessibility contract

#### Preserve initialization and reachability

- Keep `#tab-bar`, `.chat`, `#sessions-panel`, existing route/settings/refresh controls, and all currently required IDs until every `els` lookup, listener, inline bootstrap reference, CSS selector, and test is migrated atomically. Rename the visible “Sessions” label to “Operations” only if the internal `data-tab="sessions"` contract remains compatible.
- Do not add a mobile drawer in v6. Keep Chat and Operations as first-level tabs. Operations remains one primary action away and exposes route slots, sessions, events, agents, and workspace in one scroll surface; optional in-page landmark links are not nested navigation.
- Add a compact, wrapping supervision strip visible on Chat and Operations: text-labelled connection state, active server-resolved route/session, busy/queue state, and a pending-approval count button. Do not convey any state by color alone.
- Busy/queue state comes from `/v1/diagnostics.summary`, not cached `/v1/status`. Refresh it after relevant events/actions and on a bounded poll while visible.
- Remove event startup's dependency on tab visibility by reusing `startAuthenticatedChannels`; do not create a second stream or cursor owner. Load sessions/agents/workspace when Operations first opens and refresh on later opens. Stop channels and retry timers on `TokenRejected` and `pagehide`.
- Make application state—not form markup—the source of truth for target, settings, busy/recording state, and active tab before any later markup move. Required hooks fail fast in development/tests rather than silently disappearing behind optional chaining. Add a selector-parity test for all required IDs.

#### Semantic and input behavior

- Remove `aria-live` from the conversation `<main>`. The message list is `role="log" aria-live="polite" aria-relevant="additions"`; a growing streamed reply is `aria-busy="true"` and is not announced token by token. Announce completion or failure once through a separate atomic `role="status"` / urgent `role="alert"` node.
- The tab bar implements a complete tab pattern (`tablist`, `tab`, `aria-selected`, `aria-controls`, roving focus, Arrow/Home/End) or uses an equally complete native-navigation pattern; it must not mix partial ARIA with button behavior.
- Session and agent collections use semantic lists with native row buttons. Separate edit selection (`aria-pressed`/`aria-controls`) from active session (`aria-current`) and include visible status in the accessible name. Workspace entries remain native buttons.
- Approval arrival never steals focus. After a user resolves one, focus moves to the next pending approval or the pending summary. Recovery and blocking errors expose an accessible heading and status, while automatic background transitions do not unexpectedly move focus.
- Every focusable text input, select, and textarea computes to at least 16 px on iOS/mobile. Preserve pinch zoom; never add `maximum-scale` or `user-scalable=no`. Affected touch targets are at least 44×44 px.
- Preserve the current IME-safe Enter behavior, including `event.isComposing`; scope keyboard handlers to the active component rather than intercepting global shortcuts.
- The retained external Settings opener is a complete disclosure with `aria-controls="settings-panel"` and synchronized `aria-expanded`. Opening moves focus to the revealed Settings heading or first field; closing restores the opener; the normal native `<summary>` remains operable outside v5. Programmatic scrolling follows the reduced-motion rule.
- Validate all light/dark/state combinations actually shipped in v6: 4.5:1 normal text; 3:1 large text and required control/icon/boundary/focus indicators. Include canvas/surface, muted text, approval/warn/error, inputs, selected/disabled states, and focus rings; do not rely on proposed Android colors.
- One `prefers-reduced-motion: reduce` rule disables nonessential entrance/transitional motion and uses instant programmatic scrolling while preserving progress labels. Include forced-colors/system-color behavior for controls and focus.

#### Server-authoritative context display

- Do not relocate workspace or target controls in v6. The UI treats client paths, manual targets, and persisted values as untrusted hints and displays only the canonical values returned under the server enforcement in §5.2.

---

## 6. Outcome-sequenced implementation

Each phase addresses one release finding. Later phases do not begin until the earlier safety gate passes.

### Phase 0 — Connection recovery and credential boundary (R1, M)

1. Introduce the pure connection reducer, credential epochs, abort/retry ownership, authenticated status probe, and the single epoch-guarded `startAuthenticatedChannels` owner. Route `apiFetch`, direct audio fetch, SSE, and WS failures through it; keep live WS lazy unless resuming a known session.
2. Implement fragment/legacy bootstrap migration for browser and setup links, scoped tickets for SSE/WS and any URL-compatible audio, service-worker canonical cache rules, and atomic shell upgrade.
3. Enforce Origin/fetch-site/WS checks, authenticated POST mutations and the documented GET-route break, no-store/referrer/CSP headers, server-side cwd/target validation, and the text-only injection invariant.

**Gate:** reducer and integration coverage proves missing/rejected/unreachable/reconnecting/connected states, stale 401/success suppression, retry cancellation, valid replacement within 60 seconds, opaque WS/SSE classification, no long-lived bearer in browser/setup/stream/audio URLs or cache, legacy migration, cross-origin rejection, confined cwd/target resolution, hostile strings cannot execute, and the shipped CSP still permits authenticated Blob audio plus the service worker.

### Phase 1 — Live approval reachability (R2, M–L)

1. Add the gateway-owned bridge over both per-live-session registries, immutable/frozen records, cryptographic IDs, expiry, tombstones, lifecycle/audit events, and owner-loss behavior.
2. Add authenticated snapshot and idempotent resolve routes. Extend `startAuthenticatedChannels` to hydrate the approval snapshot/cursor before subscribing to incremental approval events; render cards in the existing pending region.
3. Add explicit origin/context, Approve-and-run/Reject-do-not-run language, pending/resolved/execution states, and single-announcement semantics in the same phase as the interaction.

**Gate:** terminal and command approvals created by live turns remain discoverable and resolvable through UI-mode changes, page reload, SSE reconnect, and browser-WS reconnect within their server lifetime; expiry uses server time; duplicate/conflicting resolves cannot execute twice; owner/session loss and process restart never reconstruct work; audit/tombstone and SR announcement states are correct.

### Phase 2 — Mobile supervision and structural accessibility (R3, M)

1. Inventory every `els` binding, listener, inline-script reference, selector, and initialization dependency. Establish application-state ownership, required-hook assertions, and selector parity before changing markup.
2. Retain the primary tab/initializer DOM; remove tab-visibility coupling by reusing the existing channel orchestrator, then add the supervision strip, diagnostics queue/busy refresh, display of canonical context returned by the server, and semantic Operations rows/tabs.
3. Ship dedicated log/status/alert behavior, keyboard/focus/touch/zoom/contrast/reduced-motion/forced-colors requirements with the components they affect. Preserve current text, voice upload, Stop, settings, session mutation, event, agent, and workspace flows.

**Gate:** at phone and desktop widths, connection/route/busy/queue/pending state remains visible; Operations is one primary action away; Chat, text, one-shot voice, Stop, settings, sessions, route slots, agents, events, workspace, token recovery, and approvals pass selector-parity and interaction smoke; keyboard-only, iOS Safari + VoiceOver, and desktop SR checks report no blocking issue, no focus zoom, and no focus obscured by the fixed composer/safe area.

---

## 7. Prerequisite-gated follow-up register (not v6)

These observations remain useful, but none may be pulled into a v6 phase without a separate finding, owner, acceptance gate, and scope tradeoff.

| Observation retained from the audit | Why it is deferred / prerequisite |
|---|---|
| The dock consumes substantial mobile height; voice settings, composer, status, approvals, and latest audio are stacked. | A unified composer is a behavior rewrite, not a CSS restyle. First make state authoritative. Preserve typed drafts; keep voice toggles until their replacement Settings UI exists; specify tap-start/tap-send recording, discard-only cancel, timer/chunk cleanup, track release after cancel/send/error and `pagehide`. A later Send→Stop morph keeps the same native button/focus and updates its accessible name; recording swaps define focus return and announce once. |
| Assistant bubbles constrain long output; per-message Copy/Play/Retry could improve reading. | Current messages are text-only DOM nodes; streaming rewrites `textContent`; audio has one latest player/object URL and server artifacts expire (about ten minutes by default). A follow-up needs an in-memory turn view-model, document-lifetime history statement, eager authenticated Blob ownership with a fixed cap/eviction, unavailable audio states, and cleanup on `pagehide`. Retry must be limited to an explicitly terminal failure and still warn that side effects may have partially completed; no Retry for running or successful work. Message actions require 44 px touch targets. |
| Markdown/rich rendering could improve long replies. | Preserve `textContent` until a separate security design disables raw HTML, allowlists URL schemes, sanitizes the final DOM, never parses streamed partial HTML, and lands CSP/injection regression coverage first. |
| A drawer/sidebar/sheets could reduce chrome. | The current primary tab starts sessions/agents/workspace/SSE; deletion would orphan behavior. Any future drawer must replace lifecycle bootstrap first. Mobile drawer and Settings/Workspace sheets must be labelled modals with inert background, focus entry/trap, Escape, and trigger restoration; desktop sidebar is ordinary `<nav>`. Any overflow uses a native disclosure or a complete menu keyboard pattern. |
| A full-screen live voice overlay could feel more conversational. | Browser `app.js` currently handles live text, not the gateway's binary `[4-byte sequence][PCM16k]` input or binary audio output. A future feature needs capture/resampling, sequence/dedupe, playback, resume/teardown, a dedicated labelled 44×44 “Start live voice” button, and a single modal focus model. Long-press may be redundant convenience only and must not collide with tap. Approvals replace content inside the same dialog, pause audio, focus the approval heading (not Approve), and restore focus correctly. |
| Empty-state suggestions and “Browse workspace” shortcuts could teach capability. | A suggestion must declare prefill versus send, be gated offline/degraded/busy, and never spend a queued turn unexpectedly. Workspace browsing remains an explicit UI action, not a sent suggestion. The v6 operational summary is safer. |
| Settings discoverability, manual theme, Sage & Clay, typography, skeletons, and decorative cleanup could improve polish. | Palette comes after operator outcomes and a complete web light/dark/state contrast study. `DESIGN.md` is Android-only. Manual theme also needs pre-paint persistence, `[data-theme]` overrides, `color-scheme`, theme-color/manifest alignment, and metadata/orientation decisions. Failing muted/clay combinations are not adopted by this proposal. |
| `?v=5` duplicates some minimal styling and minor polish is inconsistent. | Do not delete `.v5-controls`: it contains live target/settings/refresh controls. Retire the variant only with a compatibility window, clean selector contract, atomic HTML/JS/SW deployment, and default-vs-v5 regression coverage. Gradient removal, tabular figures, heading wrapping, skeletons, and per-message actions are separate changes—not one F11 grab-bag. |

---

## 8. Open implementation decisions

The release contract is fixed; these choices must be settled in implementation planning without weakening it:

1. **SSE credential mechanism:** one-time scoped tickets with manual reconnect versus authenticated fetch-stream SSE. The live WS still needs a short-lived scoped handshake ticket.
2. **Approval tombstone store:** exact bounded persistence/retention implementation. It must support idempotent response-loss retries and the advertised replay window, and it must never reconstruct executable work after restart.
3. **Legacy token-link window:** the exact version/date after which `/app/?token=` and `/setup?token=` bootstrap are rejected. Both remain non-cacheable and are immediately scrubbed/exchanged throughout compatibility.
4. **Privacy-preserving usage counts:** whether to add them after v6 to decide further web visual investment. They are not a release dependency and must exclude content and identifiers.

### Evidence boundaries

- Source claims above were checked against the current `web/remote` client, `control-server.ts`, realtime approval registries/gateway, and `session-events.ts`. `/v1/events` currently tails session events only; it does not already provide approval or general live tool lifecycle.
- The approval claim is intentionally limited to approvals created by **live turns**. Default non-live turns do not use these realtime registries.
- No rendered hierarchy study or user research was performed for the deferred visual ideas. They remain hypotheses, not release requirements.

### Reference inventory

- `skills/improve-ui/SKILL.md` + plan template — evidence and scope discipline
- `skills/fixing-accessibility/SKILL.md` — semantic/focus/announcement/contrast checks
- `skills/baseline-ui/SKILL.md` — deferred visual audit reference
- `skills/fixing-motion-performance/SKILL.md` — deferred motion reference
- `web/remote/app.js`, `index.html`, `sw.js` — current browser behavior
- `control-server.ts`, `realtime-gateway.ts`, `realtime-*-approval.ts`, `session-events.ts` — current transport/approval/event behavior
