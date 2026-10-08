# @rosm/mobile

The Expo (React Native, SDK 57) app — the native surface for iOS/Android. It owns
auth, GPS/background tracking, and the map; all route/GPS/OSM logic comes from
[`@rosm/core`](../../packages/core). File-based routing via `expo-router` (`src/app/`),
styling via Uniwind (Tailwind 4), maps via MapLibre.

It is **not** runnable in Expo Go — MapLibre, background location, and SecureStore are
native modules that need a **dev build**.

## Run it (dev build)

From the repo root, after `pnpm install`:

```bash
# Build + install the dev client on a booted iOS simulator, then start Metro:
pnpm --filter @rosm/mobile ios:simulator:dev-server
# Android:
pnpm --filter @rosm/mobile android:simulator:dev-server

# Metro only (once a dev build is installed):
pnpm --filter @rosm/mobile dev-server
```

`ios:simulator:dev-server` / `android:simulator:dev-server` run `expo run:*`, which prebuilds the native project and compiles the
dev client. For a physical device, use an [EAS](https://docs.expo.dev/build/introduction/)
`development` build (below).

## Environment

Point a dev build at a locally running site by copying the example env file. `pnpm dev`
at the repo root serves the site on http://localhost:4321, reachable from the iOS
simulator; for an Android emulator or a physical device the site has to listen beyond
loopback, so start it with `pnpm --filter @rosm/site dev --host` instead.

```bash
cp apps/mobile/.env.example apps/mobile/.env.local
```

```
# Read only when __DEV__ is true. iOS simulator: http://localhost:4321.
# Android emulator: http://10.0.2.2:4321 (the host machine as the emulator sees it).
# Physical device: your machine's LAN IP, e.g. http://192.168.1.10:4321.
EXPO_PUBLIC_DEV_API_BASE=http://localhost:4321

# Optional: override the map tiles (never bulk-download against tile.openstreetmap.org).
# EXPO_PUBLIC_TILE_URL=https://tiles.example.com/{z}/{x}/{y}.png
```

Expo inlines `EXPO_PUBLIC_*` at build time and loads `.env.local` for Release builds too
(e.g. `ios:device:release-build`). That is why the local override is
`EXPO_PUBLIC_DEV_API_BASE`, which the app ignores outside `__DEV__`. Do not put
`EXPO_PUBLIC_API_BASE` in `.env.local`: it is the backend non-dev builds talk to, each EAS
profile in [`eas.json`](./eas.json) sets it, and without it the app falls back to `apiBase`
in `packages/core/appConfig.json`. Set it in a build profile only to point a non-dev build
at a different backend, such as a preview deploy.

OSM sign-in reuses the site backend's `/api/osm/auth?native=1` flow and returns the token
via the `rosm://osm-callback` deep link — so the backend must be reachable from the device,
and its OSM OAuth app must allow the `http://localhost:4321/api/osm/callback` redirect (or
the LAN-IP equivalent for a physical device; see `apps/site/.env.example`). The `rosm://`
hop is internal.

## Config

`app.config.ts` pulls the app id / scheme / colors from
[`packages/core/appConfig.json`](../../packages/core/appConfig.json) — the single identity
source shared with the site. Background-location entitlements and permission strings are
declared there too.

## Build & submit (EAS)

The EAS project is already linked (`extra.eas.projectId` in `app.config.ts`). Before the
first App Store submission, replace the Apple Team / App Store Connect ID placeholders in
[`eas.json`](./eas.json).

```bash
eas build --profile development --platform ios   # dev client for a device
eas build --profile production --platform ios
eas submit --profile production --platform ios
```

App Privacy: location (when-in-use + background, "app functionality", not linked to
identity, no tracking); local notifications only.
