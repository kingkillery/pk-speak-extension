# Remote Validation Checklist

Use this run sheet when validating `pi-speak-pk` from a real phone.

Goal:
- prove Telegram remote works
- prove the built-in mobile web app works
- prove auth and token handling work remotely
- prove reply audio and queue behavior are sane
- capture enough evidence to diagnose failures quickly

---

## Run metadata

```text
Date:
Operator:
Phone/device:
Browser/app:
Network path: Tailscale | HTTPS tunnel | local Wi-Fi
Desktop host:
Pi version / package source:
Notes:
```

---

## Preflight

### P1 — Desktop services reachable

Run:

```text
/speak status
/phone status
/remote status
```

Expected:
- no obvious TTS / phone / remote errors
- `/remote` can be turned on if needed

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### P2 — Gather secrets and URLs

Run:

```text
/remote token
/remote setup
/phone code
```

Have ready:
- remote token
- browser or native setup URL from `/remote setup`
- Telegram pair code
- remote base URL like `https://<your-url>/app/`

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

---

## Telegram path

### T1 — Telegram pairing

Run:

```text
/phone on
/phone code
```

On the phone:
- open the bot
- send `/link <code>`

Expected:
- pairing succeeds
- `/phone status` reflects the linked state

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### T2 — Telegram text turn

Send a short text message from the phone.
Examples:
- `say hello from telegram`
- `what session is active`

Expected:
- Pi receives it
- text reply returns
- optional audio reply returns when spoken replies are enabled

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### T3 — Telegram voice-note turn

Send a voice note from the phone.

Expected:
- transcription succeeds
- Pi reply returns
- bridge does not wedge or silently fail

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### T4 — Telegram recovery

Run:

```text
/phone unpair
/phone code
```

Re-link with the new code.

Expected:
- old link invalidates
- new link works cleanly

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

---

## Mobile web app path

### W1 — App loads over HTTPS

Open:

```text
https://<your-url>/app/
```

Expected:
- app UI loads
- no blank page
- no token/auth loop

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### W2 — Token onboarding works

Use one of:
1. paste the token in Settings
2. open `/app/?token=YOUR_TOKEN` once

Expected:
- token is accepted
- URL is cleaned after bootstrap
- app remains usable after reload in session-storage mode

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### W3 — Browser microphone permission works

Grant mic permission and attempt to arm recording.

Expected:
- no secure-origin failure
- recording UI is usable

If this fails, the most likely cause is an insecure origin.

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### W4 — Typed fallback text turn

Send typed fallback text from the web app.

Expected:
- response returns
- no auth errors
- no stuck spinner
- optional spoken reply works if requested

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### W5 — Voice turn

Record and send a short voice turn.

Expected:
- upload succeeds
- transcription succeeds
- response returns
- optional reply audio is available

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### W6 — Reply audio playback

Trigger a turn with spoken reply enabled.

Expected:
- returned audio plays
- no broken `/v1/audio/:id` fetch
- autoplay restrictions may require user interaction, but manual play should still work

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### W7 — Remember-device behavior

Test both modes:
- session-only token storage
- remembered token on your own device

Expected:
- session-only mode clears when expected
- remembered mode persists only on that device

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### W8 — Launch path is forwarded

Set a launch path in Settings, then send one text and one voice turn.

Expected:
- text POST includes `cwd` in JSON body
- voice upload uses `?cwd=` query parameter
- gateway receives turns with that launch path (confirmed by diagnostics/logs)

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

---

## Auth and security

### A1 — Non-local unauthenticated request fails

From the phone or another non-local client, hit a control route like:
- `/v1/status`
- `/v1/diagnostics`

without auth headers.

Expected:
- request is rejected

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### A2 — Authenticated non-local request succeeds

Retry with one of:

```text
Authorization: Bearer <token>
X-Pi-Speak-Token: <token>
```

Expected:
- request succeeds

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### A3 — Localhost bypass still works

From the desktop host, call localhost without auth.

Expected:
- localhost behaves per the intended bypass rules

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### A4 — Query-token usage stays scoped

Confirm query-token auth is only being relied on for:
- `/app/?token=...`
- `/v1/audio/:id?token=...`

Expected:
- control routes use header auth, not query auth

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

---

## Queue and busy behavior

### Q1 — Sequential remote turns

Send 2–3 normal turns from the phone.

Expected:
- all succeed
- no buildup or stale queue behavior

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### Q2 — Intentional overlap

While one longer turn is running, send another remote turn quickly.

Expected:
- deterministic busy/backpressure response
- no hang
- no wedged queue

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

### Q3 — Same-session contention

While the current Pi session is busy, send a synchronous remote turn targeting it.

Expected:
- fast busy failure
- not a hanging request

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

---

## Diagnostics and failure visibility

### D1 — Diagnostics endpoint is useful

Call:

```text
GET /v1/diagnostics
```

Expected diagnostics visibility for:
- queue busy state / backlog
- recent turn timings
- last STT / TTS / phone / listener errors
- Telegram polling health
- a top-level `summary` block with queue state, queue depth, phone-linked state, mono state, current session/target, and active error sources

Record:

```text
[ ] Pass  [ ] Fail
Observed:
```

### D2 — Recoverable failure becomes visible

Cause one controlled failure, for example:
- deny browser mic
- use wrong token
- send unsupported content type

Expected:
- failure is visible in diagnostics or obvious status surfaces
- not silent

Record:

```text
[ ] Pass  [ ] Fail
Observed:
Diagnostics:
```

---

## Negative-path checks

### N1 — Browser app with bad token

Expected:
- request fails clearly
- app does not pretend success

```text
[ ] Pass  [ ] Fail
Observed:
```

### N2 — Browser app over insecure origin

If safely reproducible, try a plain HTTP non-local origin.

Expected:
- browser microphone access is blocked

```text
[ ] Pass  [ ] Fail
Observed:
```

### N3 — Spoken replies off

Run:

```text
/speak off
```

Then perform a remote turn.

Expected:
- text still works
- no broken audio-path assumptions

```text
[ ] Pass  [ ] Fail
Observed:
```

### N4 — Telegram fallback still works

If the browser app path is degraded, retry through Telegram.

Expected:
- Telegram remains a viable fallback path

```text
[ ] Pass  [ ] Fail
Observed:
```

---

## Exit criteria

Remote/mobile validation is in good shape when all of these pass:
- Telegram pairing
- Telegram text turn
- Telegram voice-note turn
- `/app/` loads over HTTPS
- browser microphone capture works
- typed web turn works
- voice web turn works
- reply audio works
- non-local unauthenticated requests fail
- authenticated non-local requests succeed
- queue/busy behavior is deterministic
- diagnostics surface useful failure state

Final summary:

```text
Overall result: Pass | Fail | Pass with caveats
Top failures:
Most useful diagnostics captured:
Recommended next fix:
```
