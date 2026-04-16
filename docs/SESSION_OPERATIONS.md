# Session Operations

This guide is the focused operator reference for `/sess`, `/attn`, and voice-driven multi-session control.

Read this after `docs/VOICE_SESSION_BRIDGE.md` when the task is specifically about:
- naming sessions
- switching sessions
- wake aliases
- cross-session voice routing
- ready-session checks
- multi-window local workflows

## Cheat Sheet

### Main dashboard

```text
/sess
```

### Fast setup

```text
/sess new bugfix
/sess wake one
```

### Most useful direct actions

```text
/sess switch bugfix
/sess rename bugfix voice-bugfix
/sess edit bugfix
/sess alias add bugfix one
/sess alias remove one
/sess remove bugfix
/sess export
```

### Advanced broker checks

```text
/attn status
/attn clear bugfix
```

## What Problem This Solves

`pi-speak-pk` lets you work with more than one Pi session without losing the speed of voice control.

The main patterns are:
- give important sessions stable names
- optionally give them short wake aliases
- use `PK <name-or-alias>` to target them by voice
- allow conservative near-matches like `peekay` and compact fused forms like `PK2` when the transcript is close
- use `/sess` to see current, ready, busy, idle, and saved sessions in one place

## Main Session Manager View

Run:

```text
/sess
```

Typical output shape:

```text
Current: voice
Ready: voice-bugfix
Store: C:\Users\...\session-routing.json
Sessions
- voice [current] [idle]
  aliases: one
- voice-bugfix [ready] [busy]
  aliases: two
- voice-docs [saved]
  aliases: three
```

### Status meanings

- `current` → the active local Pi session
- `ready` → waiting for your attention
- `busy` → actively working right now
- `idle` → live and not actively working
- `saved` → known in the routing store but no live runtime snapshot is currently visible

## Command Surface

### Primary session-manager actions

```text
/sess
/sess new bugfix
/sess switch bugfix
/sess rename bugfix voice-bugfix
/sess edit bugfix
/sess edit bugfix rename voice-main
/sess alias add bugfix one
/sess alias remove one
/sess remove bugfix
/sess confirm remove bugfix
/sess export
```

### Compatibility actions

```text
/sess list
/sess name active-work
/sess wake one
/sess wake clear one
/sess wake list
```

### Advanced broker actions

```text
/attn status
/attn list
/attn on
/attn off
/attn clear
/attn clear bugfix
```

## Natural Voice Phrases

These phrases should feel natural but still map to the real command surface:

```text
show sessions
current session
new session bugfix
switch to session research
name this session active work
set wake alias one
show wake aliases
remove session bugfix
what's ready
attention status
clear attention for bugfix
```

## Voice Phrase Matrix

| User says | Command | Notes |
|---|---|---|
| `show sessions` | `/sess` | Main manager view |
| `current session` | `/sess` | Current + ready + aliases in one view |
| `new session bugfix` | `/sess new bugfix` | Creates a new named session |
| `switch to session research` | `/sess switch research` | Uses session name or alias |
| `name this session active work` | `/sess name active work` | Names the current session |
| `edit bugfix` | `/sess edit bugfix` | Shows per-session shortcuts |
| `set wake alias one` | `/sess wake one` | Makes `PK one` route here |
| `show wake aliases` | `/sess` | Main manager view shows aliases inline |
| `remove session bugfix` | `/sess remove bugfix` | Requires confirm step |
| `what's ready` | `/sess` | Ready state is shown inline |
| `attention status` | `/attn status` | Advanced/debug path |
| `clear attention for bugfix` | `/attn clear bugfix` | Clears a ready marker |

## Typical Workflows

### 1. Create a fresh voice-targetable session

Goal: make a dedicated session for a new task and reach it quickly by voice.

Commands:

```text
/sess new bugfix
/sess wake one
```

Then later:

```text
PK one
```

That routes the next spoken request to the `bugfix` session.

### 2. Rename the current session so it is easier to reach

Goal: turn an unnamed or temporary session into a stable target.

Command:

```text
/sess name active-work
```

### 3. Inspect or edit one saved session quickly

Goal: open a session-specific shortcut view without remembering every command.

Command:

```text
/sess edit bugfix
```

Typical output includes direct next-step commands for:
- switch
- rename
- alias add
- alias remove
- remove

You can also proxy actions directly:

```text
/sess edit bugfix rename voice-bugfix
/sess edit bugfix alias add one
/sess edit bugfix alias remove one
/sess edit bugfix remove
```

### 4. Add a short alias to any saved session

Goal: route by a short spoken target without renaming the session itself.

Command:

```text
/sess alias add bugfix one
```

Legacy current-session shortcut:

```text
/sess wake one
```

### 5. Route voice into another session

Goal: stay hands-free while moving work between sessions.

Examples:

```text
PK bugfix
PK one
switch to session research
```

Behavior notes:
- `PK bugfix` or `PK one` sets the immediate voice target
- `switch to session research` issues the explicit session switch command
- if the current session is still busy, cross-session voice routing should not jump mid-turn

### 6. Safely remove a saved session entry

Goal: clear saved routing metadata without silently deleting a Pi session file.

Commands:

```text
/sess remove bugfix
/sess confirm remove bugfix
```

Behavior notes:
- requires explicit confirmation
- removes saved name and aliases for that session path
- does not silently delete the underlying Pi session file

### 7. Inspect persistence

Goal: verify the current saved routing snapshot and store path.

Command:

```text
/sess export
```

## Safe Behavior Rules

### Duplicate names are rejected

If a session name already points to a different session, the new name is rejected instead of silently overwriting the old mapping.

### Wake aliases are normalized

Aliases are matched with normalization so natural speech works better.

Examples that should map cleanly:
- `one`
- `One`
- `to google`
- `To Google`

### Session routing persists across restarts

Named sessions and wake aliases are mirrored into the shared local routing store so they survive extension restarts.

### Removal requires confirmation

`/sess remove <name>` does not immediately clear state.

Use:

```text
/sess confirm remove <name>
```

### Cross-session routing should not switch mid-turn

If Pi is still busy in one session, a voice request that would switch into another session is blocked rather than forcing a mid-stream context jump.

## User Says → Agent Does

### Session setup
- "show sessions" → `/sess`
- "make a new session for bug fixes" → `/sess new bugfix`
- "call this session active work" → `/sess name active work`
- "show the session store" → `/sess export`

### Wake targeting
- "make PK one route here" → `/sess wake one`
- "show wake aliases" → `/sess`
- "remove wake alias one" → `/sess wake clear one`

### Session cleanup
- "remove session bugfix" → `/sess remove bugfix`
- then confirm with `/sess confirm remove bugfix`

### Attention checks
- "which sessions are ready" → `/sess`
- "what is the attention status" → `/attn status`
- "clear ready state for bugfix" → `/attn clear bugfix`

## Troubleshooting

### I said a session name, but it did not route

Check:
- `/sess`
- whether the phrase is a session name or a wake alias
- whether `/mono on` is active

### I want to verify persistence

Run:

```text
/sess export
```

### Voice did not switch because Pi was busy

That is expected if the request would hop into another session while the current turn is still active.

Finish the current turn first, then retry the route.

### I have multiple local Pi windows and I lost track of them

Run:

```text
/sess
```

That is the fastest way to see current, ready, busy, idle, and saved sessions together.

### I need low-level watcher or broker details

Run:

```text
/attn status
```

That is the advanced path.

## Deep References

- `docs/VOICE_SESSION_BRIDGE.md`
- `docs/SESSION_MANAGER_SPEC.qmd`
- `README.md` → `/mono`, `/sess`, `/attn`
- `index.ts`
- `voice-session-command.ts`
- `voice-routing.ts`
- `session-routing.ts`
- `session-routing-store.ts`
- `attention-broker.ts`
