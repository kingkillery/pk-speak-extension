# Session Operations

This is the focused operator guide for `/sess` in `pi-speak-pk`. `/sess` is how you manage the sessions the conversational assistant can see and route into — it does not itself mutate a session's contents; launching, archiving, or otherwise changing agent state through the assistant always goes through its own approval flow (see `README.md#conversational-assistant-mode`).

## Main commands

```text
/sess
/sess new bugfix
/sess switch bugfix
/sess name active-work
/sess rename bugfix voice-bugfix
/sess wake one
/sess wake clear one
/sess alias add bugfix one
/sess alias remove one
/sess edit bugfix
/sess remove bugfix
/sess confirm remove bugfix
/sess slots
/sess export
/sess ui
/sess ui open
/sess bundle voice-work --note needs Chrome open with the dev profile
/sess bundle list
/sess bundle rm voice-work
/sess send mac-mini voice-work
/sess pickup
/sess import voice-work --cwd /Users/k/dev/proj --git
```

## Transfer sessions between hosts (pickup from anywhere)

A session bundle is a single portable JSON file carrying everything a session needs to continue on another machine:

- the full session transcript (JSONL)
- its routing name and wake aliases
- workspace git state: origin remote, branch, HEAD commit, the uncommitted diff as a binary patch, and the *names* of untracked files (contents never travel, so secrets stay put)
- an optional operator note for environment expectations that cannot travel — e.g. "agentic browser tests expect Chrome open with the dev profile"

### Save and list

```text
/sess bundle                       # bundle the current session under its name
/sess bundle voice-work            # bundle a named session
/sess bundle voice-work --note needs Chrome open
/sess bundle list
/sess bundle rm voice-work
```

Bundles live in `~/.pi-speak/session-bundles/<name>.pi-session.json`. This doubles as a local save/restore surface: `/sess bundle` is "save state", `/sess import <name>` is "restore".

### Move between hosts

Over ssh (the remote needs a POSIX shell for `mkdir -p`; pre-create `~/.pi-speak/session-inbox` on Windows remotes):

```text
/sess send mac-mini voice-work     # ssh mkdir + scp into mac-mini:~/.pi-speak/session-inbox/
```

then on the other host:

```text
/sess pickup                       # import every bundle waiting in the inbox
```

Any other transport works too — scp the bundle file by hand, drop it in a synced folder, or commit it to a git repo — then `/sess import <file>`.

### Import

```text
/sess import voice-work
/sess import voice-work --cwd /Users/k/dev/proj
/sess import voice-work --cwd /Users/k/dev/proj --git
```

Import writes the transcript into pi's per-cwd session directory (header cwd rewritten to the target workspace), registers the routing name (suffixing `-imported` on conflicts), and re-adds wake aliases that don't collide with existing routes — the `one`/`two` compact-lane families are never stolen. Resume with `/sess switch <name>`.

Without `--git`, the import prints the exact git commands needed to recreate a missing workspace. With `--git` it does the work: clones from the bundle's remote when the target cwd is missing, checks out the bundle's branch/commit, and applies the carried uncommitted diff with `git apply --3way` — but only onto a clean tree; local work is never overwritten.

The one thing a bundle cannot carry is the live environment itself. Whatever you record with `--note` (open browsers, running emulators, logged-in profiles) is surfaced verbatim on import as a checklist reminder.

## What `/sess` shows

Running `/sess` with no args prints a session-manager summary:

- current session
- ready sessions
- store path
- compact route ownership summary for lane `1` vs lane `2`
- known named sessions
- aliases under each session
- inline activity state such as `idle`, `busy`, or `saved`

If you want the full compact-route view, run:

```text
/sess slots
```

## Numeric wake shortcuts

For quick voice routing, the short numeric families are reserved and deterministic:

- `one`, `1`, `PK1` → family `1`
- `two`, `2`, `PK2` → family `2`

That means:

- `PK one` and `PK1` should hit the same target
- `PK two` and `PK2` should hit the same target
- family `1` stays distinct from family `2`
- `PK to Google` stays a literal multi-word target, not family `2`

## Recommended setup

Use one of these patterns.

### Descriptive only

```text
/sess name bugfix
```

Voice target:

```text
PK bugfix
```

### Fast numeric plus descriptive name

```text
/sess name bugfix
/sess wake one
```

Voice targets:

```text
PK one
PK1
PK bugfix
```

## Safe cleanup

Removal is two-step on purpose:

```text
/sess remove bugfix
/sess confirm remove bugfix
```

That clears saved routing metadata.
It does **not** delete the underlying Pi session file.

## Remote session operations from the phone

The native Android app and the browser remote both expose the same session-manager operations over the gateway HTTP surface, so `/sess`-style routing work does not require the desktop terminal:

- rename, wake-alias, archive, and remove sessions (`POST /v1/sessions/rename|alias|archive|remove`)
- set or clear the default route target (`GET/POST /v1/route`)
- inspect the compact `PK1`/`PK2` lanes (`GET /v1/sessions/slots`), mirroring `/sess slots`
- watch the live voice/admin session-event log (`GET /v1/events`), the same feed the `/sess ui` pane tails

The Android app groups these under the Agent Hub tab's OPS pane; per-session rename/alias/archive live on each expanded session lane.

The Agent Hub tab's **Tasks** pane goes further for oh-my-pk background lanes specifically: it exposes the lane → subagent hierarchy, a live transcript stream, and a direct chat composer over `/v1/herdr/agent*` (`GET /v1/herdr/agents`, `POST /v1/herdr/agent/:id/chat`, `POST /v1/herdr/agent/:id/kill`, `GET /v1/herdr/stream/:id`), plus a general task launcher (`POST /v1/sessions/launch` with a free-form prompt/model/provider) instead of only the fixed hub/Colab presets. `kill` archives the lane (same effect as `/v1/sessions/archive`) rather than sending an OS signal — there is no live IPC into the external oh-my-pk binary, so chat is implemented as submitting a normal turn targeted at the lane's name, exactly like typing `PK <session-name>`.

## Management Pane

`/sess ui` shows the session-manager summary inline and does not open another terminal by default.
The old interactive Ink pane is still available as an explicit escape hatch with `/sess ui open`.

```text
/sess ui
/sess ui open
```

Use `/sess`, `/sess slots`, and the phone remote as the normal routing surfaces. If you explicitly need the older pane, `/sess ui open` opens it on Windows. The pane is single-instance guarded so repeat launches report the running pane instead of creating more terminal windows. On other platforms the handler reports the exact `node dist/ui/admin.js` command you can run by hand. If you launch `pi-speak-admin` from a non-interactive shell, it falls back to a read-only snapshot instead of trying to enable raw mode.

### Pane layout

```text
pi-speak session manager
store: <routing-store-path>

Current: <current-session-or-(unsaved)>
Ready:   <ready-session-list>

  > <name>   [current] [ready] [activity]   aliases: <a>, <b>
    <name>   [activity]

Compact routes
1: <session> via one
2: <session> via two

Focused session
<name> (ready · busy)
path: <session-path>
aliases: <a>, <b>
compact: PK1 via one
```

`activity` is one of `busy`, `idle`, or `saved`, matching the inline state surfaced by `/sess`. The footer always tracks the currently focused row so you can see the exact session path, aliases, and compact-lane ownership before renaming or removing anything.

### Keybindings

```text
[↑]/[↓]      move focus between sessions
[tab]        cycle focus forward
[j]/[k]      vim-style focus movement
[r] rename   prompt for a new name and persist it
[a] alias    prompt for a new wake alias on the focused session
[x] remove   two-step confirm; cancels after 15s
[q] quit     close the pane
[enter]      submit rename/alias input
[esc]        cancel the active rename/alias/remove prompt
```

Rename rejects duplicate names. Aliases are normalized for whitespace before they hit the routing store. Remove is the same two-step gesture as `/sess remove` plus `/sess confirm remove`. The pane seeds its current-session context from the Pi window that launched `/sess ui`. On startup it focuses that current row when one is available; otherwise it focuses the first saved session.

### Toasts

The pane tails the voice/admin event log and surfaces a one-line toast at the bottom for three seconds.

For automation or testing, `pi-speak-admin --snapshot` renders one deterministic Ink frame to stdout and exits without starting the live input loop.

The toast band uses:

- `voice: ...` (magenta) — change came from a spoken `/sess` phrase, e.g. "rename bugfix to voice-bugfix"
- `admin: ...` (cyan) — change came from a pane keybinding

Typed `/sess` commands deliberately do not raise a toast, since the operator already sees inline feedback in `pi-coding-agent`.

### Reload across surfaces

The extension watches the routing store and reloads its in-memory state when an external write lands, so a pane-side rename or alias add shows up the next time you run `/sess` without restarting `pi-coding-agent`.
