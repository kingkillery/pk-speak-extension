# Pi Speak Android App

Native Android client for the `pi-speak-pk` remote API.

## MVP included

- Securely save base URL, remote token, and optional launch path
- Open `pi-speak://setup?base_url=...&token=...` links from `/remote setup`
- Fetch `/v1/status`
- Send text turns to `/v1/turn/text`
- Record voice and upload to `/v1/turn/voice`
- Send the selected target with each text or voice turn
- Show transcript + reply text
- Play reply audio when returned

## Default base URLs

- `debug`: `http://10.0.2.2:8767/`
- `staging`: `https://msi-1.tail1b8705.ts.net/`
- `release`: `https://msi-1.tail1b8705.ts.net/`

The app also lets you override the base URL and optional agent launch path in settings. The launch path is sent as `cwd` on text and voice turns so the gateway can run the active provider from that project directory.

## Current package

- `com.pkkidking.pispeak`

## Build types

- `debug`
- `staging`
- `release`

## Notes

- `debug` allows cleartext so it can hit a local Pi server from the emulator.
- `staging` and `release` default to the secure Funnel URL.
- Voice recording uses AAC in an MPEG-4 container and uploads as `audio/mp4`, which the Pi server already accepts.
