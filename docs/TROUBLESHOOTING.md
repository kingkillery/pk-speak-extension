# Troubleshooting

Use the section that matches the symptom. Run commands in the Pi or gateway environment unless noted otherwise.

## TTS is silent or failing

**Problem:** `/speak on` succeeds, but no audio is produced, or `/speak test` fails.

**Cause:** Auto-resolution could not find a usable provider, or `PI_SPEAK_TTS_PROVIDER` explicitly selects a backend that is unavailable. A provider can also be configured correctly but fail during synthesis or playback.

**Fix:**
1. Run `/speak status` and `/speak providers` to see the selected and available providers.
2. If `PI_SPEAK_TTS_PROVIDER` is set, unset it or change it to an installed/available backend. Auto mode tries legacy, Gemini, ElevenLabs, OpenAI, then Edge.
3. Test the bundled Edge backend directly: `pk-speak speak --provider edge test`.
4. If Edge works, use `/speak provider edge`, then `/speak test`. If it does not, check the terminal error and confirm the gateway has outbound network access.
5. For another backend, provide its dedicated credentials (for example `ELEVENLABS_API_KEY`, `PI_SPEAK_OPENAI_KEY`, or Gemini/Vertex credentials) and retry.

## Wake word is not activating

**Problem:** You say `PK`, but Pi does not open the voice-input window or respond.

**Cause:** The `listener.py` process is not running, the Python `faster-whisper` dependency is missing, or wake matching is too strict for the microphone/environment.

**Fix:**
1. Run `/mono status`; if it is off or stopped, run `/mono on` and watch the Pi terminal for listener errors.
2. Confirm the local Python stack includes `faster-whisper`, `sounddevice`, and `numpy`; install the missing dependency in the listener's Python environment.
3. Check microphone permissions and that the intended input device is available.
4. Make matching more forgiving and restart mono: set `PI_SPEAK_WAKE_SENSITIVITY=high`, then run `/mono off` and `/mono on`.
5. Say `PK` clearly near the microphone and allow the short activation window to open before speaking the request.

## Phone web app shows “network error” or a blank page

**Problem:** The app at `/app/` is blank or reports a network error when opened or when sending a turn.

**Cause:** The HTTP gateway is not running, the URL points at the wrong host/port, or the app's token does not match the gateway token.

**Fix:**
1. Run `/remote status`; start the server with `/remote on` if it is not running.
2. Open the exact URL printed by `/remote setup` (including `/app/`), preferably the HTTPS Tailscale URL for phone use.
3. Run `/remote token` on Pi and update the app's saved token/settings to the same value. If the token changed, reload the app and pair again.
4. Check that the phone can reach the host and port 8767. For browser microphone access, use HTTPS through Tailscale Serve or a tunnel rather than an insecure LAN HTTP URL.

## Gemini Live connection fails

**Problem:** Gemini Live cannot connect, immediately closes, or reports an authentication/project/model error.

**Cause:** Vertex Application Default Credentials (ADC) are absent, `GOOGLE_CLOUD_PROJECT` or location is wrong, or the configured API version/model does not match the selected Gemini backend.

**Fix:**
1. Authenticate ADC: `gcloud auth application-default login`.
2. Set and verify `GOOGLE_CLOUD_PROJECT=<your-gcloud-project>` and `GOOGLE_CLOUD_LOCATION=us-central1` (or a location where the model is available).
3. Set `PI_SPEAK_GEMINI_BACKEND=vertex` when using Vertex, or deliberately configure `developer-api` with its API key.
4. Run the smoke test before using the phone UI: `pi-speak-gemini-live-smoke --modality audio`.
5. Check `PI_SPEAK_GEMINI_API_VERSION` and `PI_SPEAK_GEMINI_LIVE_MODEL`; use the version/model supported by the selected backend. Vertex Live may require its Vertex-specific API version/location settings.

## Android app cannot connect

**Problem:** The Android app times out or cannot reach the gateway.

**Cause:** `PI_SPEAK_BASE_URL` or the app's Base URL is a LAN address, but the phone is not on that same network (or the LAN address changed). A local-only URL is not reachable over the internet.

**Fix:**
1. Prefer Tailscale: sign in to the same tailnet on the desktop and phone, then use the HTTPS Tailscale Serve URL.
2. In Android settings, open the connection/profile settings, edit **Base URL**, replace the old LAN URL with the current Tailscale or reachable gateway URL, and save it. Keep the gateway token unchanged unless you intentionally rotated it.
3. If staying on LAN, put both devices on the same Wi-Fi and use the desktop's current LAN IP with port 8767.
4. Re-run `/remote setup` to generate a QR/deep link with the current URL and token.

## `PK one` does not switch sessions

**Problem:** Saying `PK one`, `PK 1`, or `PK1` does not route to the expected compact lane.

**Cause:** `/sess` has no session assigned to the `1`/`one` route family, or the wake alias was not created. Compact routes are deterministic; they do not create a session automatically.

**Fix:**
1. Inspect routing with `/sess` or `/sess slots`.
2. Create a session: `/sess new mywork`.
3. Assign the compact lane: `/sess wake one`.
4. Confirm the mapping with `/sess slots`, then say `PK one` (or `PK1`) again. Use `/sess switch mywork` if you need to make it the active session as well.

## Telegram bot is not responding

**Problem:** Messages or voice notes sent to the Telegram bot receive no response.

**Cause:** The bot token is wrong/expired, or the Telegram bridge is not running.

**Fix:**
1. Run `/phone status`; if it reports not running, update/re-enter the token and restart the bridge.
2. Set the token with `/phone token <bot-token>` (obtain a replacement from BotFather if the token is expired or revoked).
3. Start it with `/phone on`, then run `/phone status` again.
4. Run `/phone code`, open the bot, and send `/link <code>` to pair the intended account. Confirm you are messaging the same bot whose token is configured.

## Extension is not loaded in Pi

**Problem:** Pi was reloaded, but commands such as `/speak`, `/mono`, or `/remote` are unavailable.

**Cause:** The npm installation did not complete, Pi was not reloaded after installation, or the package is not present in Pi's package list.

**Fix:**
1. Install inside Pi and wait for it to finish without errors: `pi npm i pi-pk-speak`.
2. Reload Pi after installation.
3. Run `pi npm ls` and confirm `pi-pk-speak` is listed.
4. If it is absent, repeat the install from a network-enabled terminal and resolve any displayed npm/permission error before reloading.

## `pk-speak doctor` reports issues

**Problem:** `pk-speak doctor` reports one or more failed diagnostics.

**Cause:** Each diagnostic checks a separate runtime prerequisite: a usable TTS provider, the local wake listener, the remote token, and the gateway process.

**Fix:**
1. **Missing TTS provider:** configure credentials or test the bundled fallback with `pk-speak speak --provider edge test`.
2. **Missing listener:** install the listener Python dependencies (`faster-whisper`, `sounddevice`, `numpy`), then run `/mono on`.
3. **Missing token:** set or regenerate the gateway token with `/remote token`, then use the same token in the phone client.
4. **No gateway running:** run `/remote on` (or start `pk-speak gateway`/`pk-speak tray`) and re-run the doctor command.
5. Re-run `pk-speak doctor` after each correction; use the individual status commands for details.

## Gateway crashes on start

**Problem:** The gateway exits immediately or repeatedly crashes during startup.

**Cause:** The runtime is using an unsupported Node.js version, port 8767 is already occupied, or required startup environment variables are missing/invalid.

**Fix:**
1. Check Node: `node --version`. Use Node.js 22 or newer.
2. Check the port: `netstat -an | grep 8767`. Stop the conflicting process or configure/use a free port as supported by your setup.
3. Check startup environment, especially the configured token, agent command/provider variables, and any Gemini/Telegram/TTS credentials required by the selected path.
4. Start the gateway in a terminal (`pk-speak gateway`) so the first error remains visible; correct that error, then retry `/remote on`.

## 9router model is not working

**Problem:** Turns fail after selecting `AGENT_PROVIDER=9router` or model `9router/ag/gemini-3-5-flash-high`.

**Cause:** 9router currently has `routing=false` capabilities in this integration, so it is not a supported agent provider route in that position.

**Fix:** Use the Gemini provider as the agent provider and select 9router as Gemini's text model instead:
1. Set `AGENT_PROVIDER=gemini`.
2. Set `PI_SPEAK_GEMINI_TEXT_MODEL=9router/ag/gemini-3-5-flash-high`.
3. Ensure the Gemini provider's required credentials/configuration are present.
4. Restart the gateway or Pi process, then retry the turn.

## Image paste does not work over remote access

**Problem:** Pasting an image into a remote session over plain SSH does nothing or sends no image.

**Cause:** Image paste transport is implemented for the `herdr --remote` client; a plain SSH connection does not provide that client-side image forwarding path. Installing herdr only on the server is insufficient.

**Fix:**
1. Install the herdr client on the local machine where the image is being pasted.
2. Connect using `herdr --remote` rather than plain SSH.
3. Paste the image through that client and ensure the remote session is the intended Pi/herdr workspace. Do not expect server-side-only installation or a regular SSH terminal to forward clipboard image data.

## Quick diagnostic checklist

Run these commands in order; stop at the first failure and fix the corresponding section above:

1. `pk-speak doctor`
2. `/speak status`
3. `/mono status`
4. `/remote status`
5. `pk-speak speak --provider edge 'test'`
