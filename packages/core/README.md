# @water-run/core

Platform-agnostic logic shared by [`@water-run/site`](../../apps/site) and
[`@water-run/mobile`](../../apps/mobile): GPS/distance math, the orienteering route
planner, BRouter turn extraction, Zod schemas, the Zustand stores (run / planner /
outbox), the route archive, and the live-run guidance. Nothing here touches a
browser, React Native, or Expo API directly.

## Ports

Anything platform-specific (network, key/value storage, the offline outbox store,
geolocation) is an injected **port**. Each app wires its adapters once at startup:

```ts
import { configureCore } from "@water-run/core/configure";
configureCore({ api, kv, outboxStorage, geolocation });
```

Core code reads them lazily via `corePorts()` (throws if unconfigured). Port
interfaces — plus contract-only ports the apps implement in their own UI layer
(haptics, notify, share, keep-awake, live activity, confetti) — live in
[`src/ports.ts`](./src/ports.ts).

## No build step

This is a "just-in-time" internal package: it ships TypeScript **source** via
subpath exports (`@water-run/core/geo`, `@water-run/core/stores/run`, `@water-run/core/schemas`, …),
which each app compiles as part of its own build: Vite (through Astro) for the site, Metro
for the mobile app. `zod` and `zustand` are peer dependencies so there is exactly one shared
instance per app.

Because the apps compile this source, Turborepo re-runs their lint, typecheck and test
whenever a file here changes (the `transit` task in the root `turbo.json`), so a change
that breaks a caller fails locally, not just in CI.

## Tests

```bash
pnpm --filter @water-run/core test        # vitest, node environment
```

Store/archive tests inject in-memory fake ports (see `tests/helpers/ports.ts`) rather
than mocking modules.
