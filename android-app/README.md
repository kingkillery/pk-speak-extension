# Pi Speak Android App

Native Android client for the `pi-speak-pk` remote API.

## MVP included

- Securely save base URL + remote token
- Fetch `/v1/status`
- Send text turns to `/v1/turn/text`
- Record voice and upload to `/v1/turn/voice`
- Show transcript + reply text
- Play reply audio when returned

## Default base URLs

- `debug`: `http://10.0.2.2:8767/`
- `staging`: `https://msi-1.tail1b8705.ts.net/`
- `release`: `https://msi-1.tail1b8705.ts.net/`

The app also lets you override the base URL in settings.

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
