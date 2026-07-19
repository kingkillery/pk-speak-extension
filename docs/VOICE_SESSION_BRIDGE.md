# Voice Session Bridge

Use this file as the operator bridge between natural wake phrases and the real `/sess` command surface. The wake phrase is how you start a conversation with the pi-speak conversational assistant hands-free.

## Core idea

<<<<<<< HEAD
`/mono` listens for the wake phrase `PK`. Saying `PK` opens a conversation with the assistant; the assistant can then see subagent state, interview you, and propose commands for approval.
After the wake phrase, Pi can optionally capture a session target before the spoken request.
=======
Wake phrases are how you start (or resume) a conversation with the assistant, not standalone commands. `/mono` listens for the wake phrase `PK`.
After the wake phrase, Pi can optionally capture a session target before the spoken request — the assistant then routes into that session's conversation.
>>>>>>> origin/main

Examples:

- `PK bugfix`
- `PK one`
- `PK1`
- `PK two`
- `PK2`
- `PK to Google`

## Deterministic numeric routing

Short numeric targets are intentionally normalized into two distinct families:

- family `1` → `one`, `1`, compact `PK1`
- family `2` → `two`, `2`, compact `PK2`

This is meant to keep the common fast routes stable without letting fuzzy matching blur them together.

### Safety rules

1. `one/1` and `two/2` are different families.
2. Multi-word targets stay literal.
   - `PK to Google` is treated as `to google`
   - it is **not** coerced into family `2`
3. A numeric family should belong to only one session at a time.
   - do not map `one` and `1` to different sessions
   - do not map `two` and `2` to different sessions
4. The extension rejects conflicting names or wake aliases that would make those compact routes ambiguous.

## Command bridge

Natural phrase | Real command
---|---
`show sessions` | `/sess`
`current session` | `/sess`
`new session bugfix` | `/sess new bugfix`
`switch to session research` | `/sess switch research`
`set wake alias one` | `/sess wake one`
`clear wake alias one` | `/sess wake clear one`
`show compact routes` | `/sess slots`
`export sessions` | `/sess export`
`open the session manager pane` | `/sess ui`

## Practical operator guidance

If you want the shortest possible routed targets, prefer:

- `/sess wake one`
- `/sess wake two`
- `/sess slots` to verify which session owns the `1` and `2` lanes

If you want descriptive voice targets, use full names like:

- `bugfix`
- `research`
- `to Google`

That gives you both:

- fast compact routes: `PK1`, `PK2`
- descriptive routes: `PK bugfix`, `PK to Google`
