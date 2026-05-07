# Pi Speak Android App

Native Android client for the `pi-speak-pk` remote API.

## MVP included

- Securely save base URL, remote token, and optional launch path
- Select saved Tailscale or Bluetooth local-link machine profiles
- Open `pi-speak://setup?base_url=...&token=...&machine_id=...&profile_name=...&connection_mode=...` links from `/remote setup` or the desktop tray QR code
- Fetch `/v1/status`
- Send text turns to `/v1/turn/text`
- Record voice and upload to `/v1/turn/voice`
- Send the selected target with each text or voice turn
- Show transcript + reply text
- Play reply audio when returned

## Default base URLs

- `debug`: `http://100.76.136.91:8767/`
- `staging`: `http://100.76.136.91:8767/`
- `release`: `http://100.76.136.91:8767/`

## Built-in machine profiles

- `MSI / appserver`: `http://100.76.136.91:8767/`
- `Mac`: `http://100.76.176.119:8767/`
- `Bluetooth / local link`: `http://192.168.44.1:8767/`

The app also lets you override the base URL, connection type, and optional agent launch path in settings. Bluetooth mode is for a paired Bluetooth PAN/local-link connection; edit the base URL if the desktop Bluetooth adapter uses a different IP. The launch path is sent as `cwd` on text and voice turns so the gateway can run the active provider from that project directory.

## Current package

- `com.pkkidking.pispeak`

## Build types

- `debug`
- `staging`
- `release`

## Notes

- Builds default to Tailscale IP endpoints and include a Bluetooth local-link profile for paired-device use.
- Cleartext is enabled because approved tailnet and Bluetooth local-link endpoints reach the local remote API over HTTP on port `8767`.
- Voice recording uses AAC in an MPEG-4 container and uploads as `audio/mp4`, which the Pi server already accepts.
