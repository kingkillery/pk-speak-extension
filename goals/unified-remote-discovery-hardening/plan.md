**Solution Approach**

Finish the discovery work as a hardened two-layer system: mDNS/DNS-SD as the primary local discovery path, UDP broadcast as a fallback, and QR/manual setup as the reliable Tailscale fallback. Close the operational gaps by making stop/cancel locally authoritative in Android, exposing server discovery diagnostics, and keeping auth material out of public discovery surfaces.

**Ordered Steps**

1. Confirm server-side mDNS advertisement in `control-server.ts`.
   - Keep `_pispeak._tcp.local` advertisement tied to `ControlServer.start()` and `ControlServer.stop()`.
   - Publish TXT fields for `app`, `pkg`, `version`, `api`, `auth`, `pairing`, `path`, and `caps`.
   - Do not publish token, setup URL, workspace path, target/session names, or route state.
   - Verification: run `npm run build`; browse with `bonjour-service` and confirm a `pispeak` service on port `8767`.

2. Confirm Android mDNS client behavior in `VoiceAgentClient.kt`.
   - Keep `NsdManager.discoverServices("_pispeak._tcp.", ...)` before UDP fallback.
   - Resolve services into `http://<host>:<port>` candidates.
   - Fetch `/.well-known/pi-speak` before showing a server as online.
   - Verification: run `./gradlew.bat assembleDebug`; install APK; use Discovery tab on the phone.

3. Tighten Android stop/cancel behavior in `MainActivity.kt` and `VoiceAgentClient.kt`.
   - Track the current turn `Job`.
   - When Stop turn is tapped, cancel the local job, stop TTS/playback, call `/v1/turn/cancel`, and mark a stop generation/id.
   - Before applying any turn result, verify it still belongs to the active generation/id.
   - Verification: start a long text/voice turn, tap Stop turn, confirm the UI stays stopped and does not later overwrite with the old response.

4. Add gateway discovery diagnostics in `control-server.ts`.
   - Track `udpEnabled`, `udpPort`, `mdnsEnabled`, `mdnsService`, and `lastError`.
   - Include diagnostics in protected `/v1/diagnostics`.
   - Keep public descriptor minimal and non-secret.
   - Verification: authenticated `GET /v1/diagnostics` shows discovery status; tests assert shape without depending on platform mDNS success.

5. Adjust Android discovery UI copy in `MainActivity.kt`.
   - Make copy say LAN/mDNS/UDP discovery plus QR/manual fallback.
   - Avoid implying Tailscale broadcast discovery is guaranteed.
   - Verification: visual/manual check on phone Discovery tab.

6. Preserve and expand automated tests in `tests/control-server.test.mjs`.
   - Keep generated-token, descriptor no-token-leak, UDP announce, and cancel-turn tests passing.
   - Add diagnostics assertions for discovery status fields.
   - Avoid flaky mDNS network tests in CI; verify mDNS manually with a bounded local browse command.
   - Verification: `npm test` passes.

7. Build, deploy, and clean commit scope.
   - Run `npm test`.
   - Run `./gradlew.bat assembleDebug`.
   - Install `android-app/app/build/outputs/apk/debug/app-debug.apk`.
   - Copy APK to `android-app/.build-outputs/app-debug.apk`.
   - Restart gateway and reapply setup deep link.
   - Stage only project files relevant to discovery/progress/cancel work; exclude `.codegraph/`, `tmp-phone-turn.*`, and unrelated skill edits.

**Risks And Open Questions**

- mDNS may be blocked by network/firewall policy on some Wi-Fi networks, so QR/manual setup must remain the reliable fallback.
- UDP broadcast is not expected to work reliably across Tailscale; Tailscale users should use QR/manual setup or known Tailscale base URLs.
- Full pairing with issued per-client tokens and revocation remains a larger auth-model change. Current scope keeps `setup-qr` pairing and generated install token behavior.
- Android `NsdManager.resolveService` has deprecated overload warnings on the current SDK; keep it for compatibility unless a focused API-level migration is needed.
