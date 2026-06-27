# Remote Operating Guide

This guide is for the person actually using Pi from a phone.

## Pick The Right Remote Path

### Use Telegram if you want the least setup

Good for:

- quick remote turns
- unreliable networks
- simple text and voice-note usage

Start it:

```text
/phone setup
/phone token <bot-token>
/phone on
/phone code
```

If the bot token is already configured in the environment, `/phone setup` will say so and point you straight to the pair code.

### Use the built-in web app if you want the best remote voice UX

Good for:

- browser microphone capture
- browser audio playback
- installable Android home-screen app
- low-friction repeated use

Start it:

```text
/remote setup
```

Then open:

```text
https://<your-url>/app/
```

`/remote setup` prints a token-bootstrap browser URL and a native Android `pi-speak://setup` link. Use that first so the phone does not need manual token copying.

### Connect over Bluetooth local-link

Pair the phone with the desktop using Bluetooth networking/PAN, then run:

```text
/remote setup bluetooth
```

The native Android setup link marks the profile as Bluetooth, so Tailscale is not required. If your desktop Bluetooth adapter uses a different IP than the printed URL, edit the Base URL in Android settings and keep the connection type set to Bluetooth. Set `PI_SPEAK_BLUETOOTH_BASE_URL` before launching Pi Speak if you already know the adapter URL.

### Connect over Tailscale

Both the desktop and phone need to be signed into the same Tailscale tailnet. On the desktop running Pi Speak, start the gateway with `/remote on`, then expose it with Tailscale Serve:

```powershell
tailscale serve --bg http://127.0.0.1:8767
```

Use the HTTPS URL printed by Tailscale as the Android Base URL, or run `/remote setup` after `PI_SPEAK_PUBLIC_BASE_URL` is set to that URL so the setup link is prefilled. Keep Tailscale enabled on Android before sending voice or text turns.

### Choose the launch path

In native Android settings, set Launch path to the project directory the active provider should run from, for example `C:\dev\Desktop-Projects\my-project`. The app sends that value as `cwd` with text and voice turns. If it is blank, the gateway uses `AGENT_CWD`, `AGENT_WORKSPACE`, or the directory where the extension process started.

### Review files and pick the working directory from the web app

The web app's **Workspace** tab lets you inspect the machine and set where the agent runs without editing settings by hand:

1. Open the **Workspace** tab in the web app.
2. Browse the directory tree from the workspace root. Tap a folder to step into it, or use the parent entry to step back up.
3. Tap a file to open a read-only viewer of its contents. Large files preview only the first 512 KB and show a truncation notice; binary files show a "binary file" notice instead of raw bytes.
4. When you are in the folder the agent should run from, tap **Use this folder**. That path becomes the launch path / `cwd` sent with subsequent text and voice turns.

Set `PI_SPEAK_WORKSPACE_ROOT` on the gateway to control the root the Workspace tab can browse. The browser cannot leave that root; requests for paths outside it (including symlinks/junctions that resolve outside it) are rejected. **If unset, the root defaults to the agent working directory** (`AGENT_CWD` / `AGENT_WORKSPACE` / the process cwd), not the whole drive — the file viewer reads file *contents* under this root, so the default is intentionally narrow to avoid exposing arbitrary files to anyone holding the remote token. Set `PI_SPEAK_WORKSPACE_ROOT` to a specific directory to widen or relocate the root, or to `fs` to deliberately browse the entire drive/filesystem.

The Workspace tab is backed by two read-only HTTP endpoints (both auth-gated like the other control routes):

- `GET /v1/workspace?path=<absolute path>` lists one directory. The response `workspace` object includes `root`, `current`, an optional `parent` (absent when `current` equals `root`), the server `defaultPath`, an `entries` array, and a `truncated` flag (true when the directory had more than 2000 entries and the list was capped). Entries are sorted directories-first then files (alphabetical) and now include files as well as directories; each entry has `name`, `path`, and `type` (`"directory"` or `"file"`), with `size` in bytes on files.
- `GET /v1/workspace/file?path=<absolute path>` returns a read-only preview: `file` carries `name`, `path`, `size`, `truncated`, `binary`, and `content`. When `binary` is true the content is empty (show a binary notice); when `truncated` is true the content holds only the first 512 KB of a larger file. The path is confined to the workspace root, so it returns `400` (missing path or a directory), `403` (path outside root), `404` (not found), or `500` on error.

### Use Unified Remote if you mainly want buttons

Good for:

- toggles
- provider switching
- pair-code lookup

Bad for:

- real voice transport
- conversational audio

## Recommended Android Setup

### Best setup

1. Run `/remote on`
2. Put the desktop behind Tailscale Serve or Cloudflare Tunnel
3. Open `/app/` on the phone
4. Save the token once in the current browser session
5. Turn on “Remember this device” only if this is your own phone
6. Add the app to the Android home screen
7. Keep Telegram as fallback

This gives you:

- phone mic in
- phone speaker out
- token-protected remote control
- no dependence on Unified Remote for audio

## Security Checklist

1. Set `PI_SPEAK_HTTP_TOKEN`
2. Use HTTPS for remote use
3. Treat `/remote token` like a secret
4. Use header auth for remote requests; query-string auth is only for `/app/?token=...` bootstrap and reply-audio playback
5. If a token leaks, set a new one and restart `/remote`

## Operator Checks

For a full live phone validation run, use `docs/REMOTE_VALIDATION_CHECKLIST.md`.
For a compact pass/fail worksheet during the run, use `docs/REMOTE_VALIDATION_RUN_SHEET.md`.

Use these when the remote path is acting up:

1. `/remote status`
2. `GET /v1/diagnostics`
3. `/phone status`

What diagnostics now surface:

- queue busy state and backlog
- recent turn timings
- last listener, phone, STT, and TTS errors
- Telegram polling health
- a compact `summary` block with queue state, queue depth, phone-linked state, mono state, current session/target, and active error sources

## Failure Modes

### Browser app loads, but recording fails

The URL is not secure enough for microphone access.

### Voice uploads work, but no audio reply plays

Check:

1. the app setting for spoken replies
2. browser autoplay restrictions
3. whether `/speak` works locally

### Telegram works, but the browser app does not

That usually means:

- bad token
- bad HTTPS origin
- browser mic permissions were denied

### Requests fail after several remote turns

That is usually one of:

- the remote queue is full
- the non-local rate limit was hit
- Pi is still working through an earlier turn

Use `/v1/diagnostics` to see whether the queue is busy.
