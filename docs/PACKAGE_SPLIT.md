# Package Split

This repo now separates the user-facing bootstrap CLI from the Pi extension package identity.

## Packages

### `pk-speak`

Root package. This is the desktop/bootstrap package and the right GitHub package surface for users who want:

- first-time setup with `pi-speak-pk`
- day-to-day commands with `pk-speak`
- tray/gateway/mobile setup helpers
- phone gateway control for conversational coding agents

Primary commands:

```text
pi-speak-pk
pk-speak doctor
pk-speak tray
pk-speak mobile
pk-speak gateway
```

### `pi-pk-speak`

Standalone Pi extension package under `packages/pi-pk-speak`.

This is the package users should install inside Pi:

```text
pi npm i pi-pk-speak
```

It contains the actual extension entrypoint at `dist/index.js`, plus the session manager UI, gateway/tray helpers, listener assets, Android APK, and remote web app.

## Syncing The Extension Package

Build and materialize the standalone extension package:

```text
npm run build:pi-extension
```

That command:

1. builds the root TypeScript output;
2. builds the Ink UI bundle;
3. copies the extension/runtime payload into `packages/pi-pk-speak`;
4. writes `packages/pi-pk-speak/package.json` with the current root version.

Generated payload directories under `packages/pi-pk-speak` are ignored in the main repo. They can be published from that package directory or copied into a separate `pi-pk-speak` repository.

## GitHub/Subrepo Strategy

Keep `pk-speak` as the primary GitHub package option in this repo.

For the Pi extension subrepo, use one of these flows:

```text
npm run build:pi-extension
```

Then either:

- publish from `packages/pi-pk-speak`; or
- sync/copy that directory into a dedicated `pi-pk-speak` repository; or
- use a future subtree split workflow once the standalone repo is created.

Do not ask Pi users to install the root `pk-speak` package as their extension. Use `pi-pk-speak` for the actual Pi extension install path.
