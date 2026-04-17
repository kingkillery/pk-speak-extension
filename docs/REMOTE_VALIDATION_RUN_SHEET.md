# Remote Validation Run Sheet

Use this compact form during a live phone validation session for `pi-speak-pk`.

For full procedure details, expected behavior, and troubleshooting notes, see:
- `docs/REMOTE_VALIDATION_CHECKLIST.md`
- `docs/REMOTE_OPERATING_GUIDE.md`

---

## Session metadata

```text
Date:
Operator:
Phone/device:
Browser/app:
Network path:
Desktop host:
Build / package source:
General notes:
```

---

## Preflight

```text
[ ] P1 Desktop services reachable (/speak status, /phone status, /remote status)
[ ] P2 Token + Telegram pair code gathered
Notes:
```

---

## Telegram

```text
[ ] T1 Pairing works
[ ] T2 Text turn works
[ ] T3 Voice-note turn works
[ ] T4 Unpair + re-link recovery works
Notes:
Diagnostics captured:
```

---

## Mobile web app

```text
[ ] W1 /app/ loads over HTTPS
[ ] W2 Token onboarding works
[ ] W3 Browser microphone permission works
[ ] W4 Typed fallback text turn works
[ ] W5 Voice turn works
[ ] W6 Reply audio playback works
[ ] W7 Remember-device behavior works as expected
Notes:
Diagnostics captured:
```

---

## Auth and security

```text
[ ] A1 Non-local unauthenticated control request fails
[ ] A2 Authenticated non-local control request succeeds
[ ] A3 Localhost bypass works as expected
[ ] A4 Query-token usage stays scoped to onboarding/audio cases
Notes:
```

---

## Queue and busy behavior

```text
[ ] Q1 Sequential remote turns succeed
[ ] Q2 Overlapping remote turns return deterministic busy/backpressure behavior
[ ] Q3 Same-session contention fails fast instead of hanging
Notes:
Diagnostics captured:
```

---

## Diagnostics and failure visibility

```text
[ ] D1 /v1/diagnostics exposes useful runtime state
[ ] D2 At least one controlled failure becomes visible in diagnostics/status
Notes:
```

---

## Negative-path checks

```text
[ ] N1 Bad token fails clearly
[ ] N2 Insecure-origin mic behavior matches expectations
[ ] N3 Remote turns still work cleanly with /speak off
[ ] N4 Telegram remains a fallback when browser path is degraded
Notes:
```

---

## Final verdict

```text
Overall result: Pass | Fail | Pass with caveats
Top failures:
Most useful diagnostics captured:
Recommended next fix:
Follow-up owner:
```