# Remote Chat UI Variation Review

Date: 2026-05-09

## Scoring Rubric

Each variation is scored 1-10 across:

- Simplicity: how few concepts the user must understand.
- Chat-first: how much of the viewport and workflow belongs to the conversation.
- Setup clarity: how hard it is to get from a fresh phone to a working remote.
- Mobile fit: whether controls stay usable on a narrow phone viewport.
- Dev effort: higher means easier to ship safely from the current code.

## Ranked Results

| Rank | Variation | Direction | Avg | Verdict |
|---:|---|---|---:|---|
| 1 | V2 | One-pane onboarding gate | 8.2 | Best default. It removes setup ambiguity and keeps the chat clean after the token exists. |
| 2 | V8 | Always-visible compact settings card | 7.8 | Strong operator design if the settings card stays short. Better for repeat configuration than first-run focus. |
| 3 | V4 | Chat-first fixed composer | 7.6 | Best conversation feel, but weaker for first-time setup and token recovery. |
| 4 | V7 | Checklist onboarding gate | 6.8 | Strongest setup clarity, but copy-before-chat can slow repeat users. |
| 5 | V6 | One-line status model | 6.8 | Good supporting idea. It should be folded into the winner rather than shipped alone. |
| 6 | V1 | Three-block layout | 6.6 | Clean, but less decisive than V2 because setup still competes with the transcript. |
| 7 | V5 | Pure minimalism | 6.4 | Visually quiet, but it hides too much state for setup and recovery. |
| 8 | V3 | Sticky settings side panel | 5.8 | Useful on desktop, poor fit for the phone-first remote use case. |

## Recommended Direction

Ship V2 as the base: onboarding is the only visible task until a token exists, then the app becomes a chat-first transcript with a fixed composer and compact route/settings controls.

Fold in:

- V4: fixed bottom composer and large transcript.
- V6: one-line status summary instead of route/provider chatter.
- V8: compact settings rows for repeat operators, but keep them secondary after onboarding.

Avoid:

- V3 side panels. They are expensive on mobile.
- V5-only minimalism. It looks clean but removes recovery cues.
- A hard V7 copy gate. Copy setup should be prominent, not required if a token is already present.

## Current Implementation Notes

The current files now mostly follow the V2/V4 hybrid:

- `web/remote/index.html` has `#app-root`, `#setup-banner`, chat transcript, and fixed `#dock`.
- `web/remote/app.js` locks chat/dock until a token exists.
- Onboarding token save, remember-token, target save/reset, token save/forget, autoplay, and live-mode controls are wired.
- Reply text now appends to chat even when legacy hidden output elements are absent.

## Scores

| Variation | Simplicity | Chat-first | Setup clarity | Mobile fit | Dev effort | Avg |
|---|---:|---:|---:|---:|---:|---:|
| V1 Three blocks | 7 | 7 | 6 | 7 | 6 | 6.6 |
| V2 Onboarding gate | 8 | 8 | 9 | 8 | 8 | 8.2 |
| V3 Sticky side settings | 6 | 6 | 7 | 4 | 6 | 5.8 |
| V4 Chat-first composer | 8 | 10 | 5 | 8 | 7 | 7.6 |
| V5 Pure minimalism | 8 | 8 | 4 | 7 | 5 | 6.4 |
| V6 One-line status | 8 | 8 | 6 | 8 | 4 | 6.8 |
| V7 Checklist onboarding | 8 | 5 | 9 | 8 | 4 | 6.8 |
| V8 Compact settings card | 8 | 7 | 9 | 7 | 8 | 7.8 |

