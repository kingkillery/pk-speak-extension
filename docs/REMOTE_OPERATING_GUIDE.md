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
/phone on
/phone code
```

### Use the built-in web app if you want the best remote voice UX

Good for:

- browser microphone capture
- browser audio playback
- installable Android home-screen app
- low-friction repeated use

Start it:

```text
/remote on
/remote token
```

Then open:

```text
https://<your-url>/app/
```

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

Use these when the remote path is acting up:

1. `/remote status`
2. `GET /v1/diagnostics`
3. `/phone status`

What diagnostics now surface:

- queue busy state and backlog
- recent turn timings
- last listener, phone, STT, and TTS errors
- Telegram polling health

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
