# Voice Session Bridge

Use this file as the main command-bridge reference for natural voice and chat control of `pi-speak-pk`.

It is intentionally written as an operator bridge, not a full implementation spec.
For deep behavior, read the linked source and README sections.

## Purpose

This bridge lets an agent or operator talk about the extension naturally while still grounding actions in the real commands and runtime behavior.

Use it when the user says things like:
- "make Pi talk"
- "turn on the wake phrase"
- "make a new session for bug fixing"
- "route voice to research"
- "check what sessions are ready"
- "set a wake alias"
- "open the phone remote"

## Command Families

### Spoken replies
- `/speak on`
- `/speak off`
- `/speak status`
- `/speak test`

Natural intents:
- "enable speech"
- "make Pi speak"
- "test the voice"
- "turn spoken replies off"

Primary references:
- `README.md` → `### /speak`
- `index.ts` → `registerCommand("speak")`
- `tts.ts`

### Local wake-word listener
- `/mono on`
- `/mono off`
- `/mono status`

Natural intents:
- "start listening"
- "turn on hands-free mode"
- "enable the PK wake phrase"
- "turn the listener off"

Key runtime notes:
- wake phrase defaults to `PK`
- conservative near-matches like `peekay` can still activate the listener when transcription is slightly off
- compact fused forms like `PK2` or `PKone` can be interpreted as wake phrase plus target
- `PI_SPEAK_WAKE_SENSITIVITY=low|medium|high` controls how forgiving wake activation should be, with optional low-level env overrides for fuzzy distance and compact-prefix handling
- short interrupt phrases like `stop` and `stop speaking` cut playback
- multi-session targeting starts from the wake phrase plus a name or alias

Primary references:
- `README.md` → `### /mono`
- `listener/listener.py`
- `index.ts` → `registerCommand("mono")`

### Session manager
Primary surface:
- `/sess`
- `/sess new <name>`
- `/sess switch <name-or-alias>`
- `/sess rename <name-or-alias> <new-name>`
- `/sess edit <name-or-alias>`
- `/sess alias add <session> <alias>`
- `/sess alias remove <alias>`
- `/sess remove <name-or-alias>`
- `/sess confirm remove <name-or-alias>`
- `/sess export`

Compatibility surface:
- `/sess list`
- `/sess name <name>`
- `/sess wake <alias>`
- `/sess wake clear <alias>`
- `/sess wake list`

Natural intents:
- "show sessions"
- "what session am I in"
- "new session bugfix"
- "switch to session research"
- "name this session active work"
- "edit bugfix"
- "set wake alias one"
- "remove session bugfix"
- "export sessions"

Key runtime notes:
- `/sess` is the main dashboard and summary view
- `/sess edit <session>` is a convenience wrapper for per-session shortcuts and action proxying
- readiness is shown as one session property inside the session manager
- duplicate session names are rejected
- saved names and aliases persist across restarts via the shared routing store
- removing a session requires explicit confirmation and only removes saved routing metadata, not the underlying Pi session file

Primary references:
- `README.md` → `### /sess`
- `docs/SESSION_OPERATIONS.md`
- `index.ts` → `registerCommand("sess")`
- `session-routing.ts`
- `session-routing-store.ts`
- `voice-routing.ts`
- `voice-session-command.ts`

### Advanced ready-state broker
- `/attn status`
- `/attn list`
- `/attn on`
- `/attn off`
- `/attn clear`
- `/attn clear <session>`

Natural intents:
- "attention status"
- "clear attention for bugfix"

Key runtime notes:
- `/attn` is still supported for advanced or debugging workflows
- the normal operator path should prefer `/sess`
- one local window may still act as the watcher behind the scenes

Primary references:
- `README.md` → `### /attn`
- `index.ts` → `registerCommand("attn")`
- `attention-broker.ts`

### Remote control paths
Telegram:
- `/phone on`
- `/phone off`
- `/phone status`
- `/phone code`
- `/phone unpair`

Browser remote:
- `/remote on`
- `/remote off`
- `/remote status`
- `/remote token`

Natural intents:
- "set up Telegram control"
- "open the browser remote"
- "show the remote token"
- "turn remote mode on"

Primary references:
- `README.md` → `### /phone`
- `README.md` → `### /remote`
- `phone-bridge.ts`
- `control-server.ts`

## Behavior Bridge Rules

When an agent handles natural-language requests about this extension:

1. Translate the intent into the smallest real command surface first.
2. Prefer existing commands over inventing new control flows.
3. For session and voice routing questions, prefer `/sess` as the main user-facing abstraction.
4. Treat attention-broker details as implementation internals unless the user is explicitly debugging them.
5. For implementation changes, preserve the natural-language bridge and the slash-command behavior together.
6. When adding new session-control behavior, update all of:
   - `SKILL.md`
   - `docs/VOICE_SESSION_BRIDGE.md`
   - `docs/SESSION_OPERATIONS.md`
   - `AGENTS.md`
   - `CLAUDE.md`
   - `README.md`

## Natural Language To Command Examples

- "make Pi talk" → `/speak on`
- "stop talking" → `/speak off` or spoken interrupt while audio is active
- "start listening for PK" → `/mono on`
- "show sessions" → `/sess`
- "what session am I in" → `/sess`
- "create a session for bug fixes" → `/sess new bugfix`
- "switch to research" → `/sess switch research`
- "call this session active work" → `/sess name active work`
- "edit bugfix" → `/sess edit bugfix`
- "make PK one route here" → `/sess wake one`
- "remove session bugfix" → `/sess remove bugfix`
- "which sessions are ready" → `/sess`
- "show the session store" → `/sess export`
- "turn on the phone remote" → `/phone on`
- "turn on the browser remote" → `/remote on`

## Example-Heavy Scenarios

### Scenario: user wants one place to inspect everything
- user says: "show sessions"
- agent maps to: `/sess`
- expected result: current session, ready sessions, aliases, and inline busy/idle/saved state

### Scenario: user wants to set up a clean bugfix lane
- user says: "make a new bugfix session"
- agent maps to: `/sess new bugfix`
- good follow-up: suggest `/sess wake one` if the user wants a short spoken target
- deeper operator steps live in `docs/SESSION_OPERATIONS.md`

### Scenario: user wants hands-free routing to a workstream
- user says: "make PK one go here"
- agent maps to: `/sess wake one`
- later spoken route: `PK one`
- if they want the full matrix of spoken session phrases, point them to `docs/SESSION_OPERATIONS.md`

### Scenario: user wants safe cleanup of a saved session entry
- user says: "remove bugfix"
- agent maps to: `/sess remove bugfix`
- expected follow-up: `/sess confirm remove bugfix`
- explain that this clears saved routing metadata rather than silently deleting session files

### Scenario: user wants low-level ready-state details
- user says: "attention status"
- agent maps to: `/attn status`
- this is the advanced path, not the normal main interface

## Deep Knowledge Map

If the user asks how something works, use this map:

- command registration and orchestration → `index.ts`
- voice phrase parsing for session actions → `voice-session-command.ts`
- normalized name and alias matching → `voice-routing.ts`
- session manager formatting and session-removal helpers → `session-routing.ts`
- durable routing store → `session-routing-store.ts`
- listener runtime and audio segmentation → `listener/listener.py`
- local ready-state broker → `attention-broker.ts`
- operator usage and examples → `README.md`
- session-focused operator flows → `docs/SESSION_OPERATIONS.md`
- manager-shape design note → `docs/SESSION_MANAGER_SPEC.qmd`

## Testing Guidance

When you change this area, prefer tests around extracted pure logic first:
- `tests/voice-session-command.test.mjs`
- `tests/session-routing.test.mjs`
- `tests/session-routing-store.test.mjs`
- `tests/voice-routing.test.mjs`
- `tests/session-command-integration.test.mjs`
- `tests/attention-broker.test.mjs`

Then run:

```bash
npm test
```
