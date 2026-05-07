# Session Operations

This is the focused operator guide for `/sess` in `pi-speak-pk`.

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
```

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
