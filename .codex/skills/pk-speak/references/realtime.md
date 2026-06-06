# pk-speak Realtime Voice Notes

## Current Repo Capability

`pk-speak` has a realtime Gemini Live path in addition to ordinary turn-based voice:

- `gemini-live-smoke.ts` verifies Gemini Live connectivity.
- `gemini-live-turn.ts` runs text or Live turns through Google GenAI.
- `realtime-gateway.ts` bridges Android/browser WebSocket audio to Gemini Live.
- `control-server.ts` exposes the local gateway route used by clients.
- `docs/realtime-gateway-evidence.md` records prior build/test evidence.
- `docs/REALTIME_CONVERSATION_DEV_FLOW.md` explains the intended architecture.

The recommended production shape is:

```text
phone/browser mic -> local gateway -> realtime voice model -> reducer/router -> coding backend
```

Do not send provider credentials to phone/browser clients.

## Gemini Live Smoke Test

Windows example:

```text
set PI_SPEAK_GEMINI_BACKEND=vertex
set GOOGLE_CLOUD_PROJECT=<project>
set GOOGLE_CLOUD_LOCATION=us-central1
gcloud auth application-default login
pi-speak-gemini-live-smoke --model gemini-2.5-flash-native-audio-preview-12-2025 --modality audio
```

## Gateway With Gemini Live

```text
set AGENT_PROVIDER=gemini-live
set PI_SPEAK_GEMINI_BACKEND=vertex
set GOOGLE_CLOUD_PROJECT=<project>
set GOOGLE_CLOUD_LOCATION=us-central1
set PI_SPEAK_GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
pk-speak gateway
```

## Practical Guidance

- Use `pk-speak speak` for reliable one-shot spoken feedback.
- Use the mobile/browser turn-based flow for normal remote voice work.
- Use Gemini Live realtime only when testing low-latency conversation or barge-in behavior.
- Keep command execution behind local gateway policy and confirmation checks.
- Treat realtime speech as the interface layer, not the final coding agent.
