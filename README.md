# Water Run — Fountain Run Planner

Plan a running route past OpenStreetMap points (drinking fountains by default), run it
on your phone with turn-toward-next-point guidance, and record each point's real-world
state back to OSM (`check_date`, `disused:`, `abandoned:`) as you go.

## How it works

1. **Find points** — fetches OSM features matching a tag (`amenity=drinking_water` default,
   any `key=value` supported) within a radius via the Overpass API.
2. **Plan route** — picks and orders a subset that fits a **target run distance** (so you can
   split the city across multiple runs), then draws a real walking/running route via the free
   BRouter API. Loop or one-way, your choice.
3. **Run** — mobile-first view: live distance + compass arrow to the next point. On arrival,
   mark it **Working** / **Out of order** / **Removed**, which writes the edit to OSM under one
   changeset for the run.

State mapping (OSM lifecycle convention):

| Action       | Effect on the node                                                |
| ------------ | ----------------------------------------------------------------- |
| Working      | set `check_date=<today>`                                          |
| Out of order | move `amenity=drinking_water` → `disused:amenity=...`, stamp date |
| Removed      | move → `abandoned:amenity=...`, stamp date                        |
| Delete (adv) | delete the node entirely                                          |

## Monorepo layout

A pnpm + [Turborepo](https://turbo.build) monorepo with two apps and shared logic:

```
apps/
  site/    @water-run/site   — Astro + Svelte site + /api backend (deployed to Vercel)
  mobile/  @water-run/mobile — Expo (React Native) app for iOS/Android
packages/
  core/              @water-run/core — shared logic (GPS math, routing, Zod schemas,
                     Zustand stores, route archive) behind injected platform ports
  typescript-config/ shared tsconfig base
```

`@water-run/core` holds everything platform-agnostic and reaches for no browser / native API
directly — each app injects its own adapters (storage, geolocation, network, …) via
`configureCore()`. That's how the same GPS/route/OSM logic runs on both surfaces.

## Prerequisites

- **Node 24+** and **pnpm 11** (pinned via `packageManager`; run `corepack enable`).
- For the mobile app: Xcode + an iOS Simulator (or an Android emulator), and an
  [Expo](https://expo.dev) account for device / TestFlight builds.

## Quick start

```bash
pnpm install            # once, at the repo root (never inside a package)

pnpm dev                # start the site (http://localhost:4321)
pnpm --filter @water-run/mobile dev-server   # start the mobile dev server
```

Workspace-wide tasks run through Turborepo, cached per package: a package's task
re-runs when its own files or those of a workspace package it depends on change.

```bash
pnpm lint        # eslint across all packages
pnpm typecheck   # tsc --noEmit (astro check for the site) across all packages
pnpm test        # vitest (core + site)
pnpm build       # production builds
pnpm format      # prettier --write .
```

Target a single package with `pnpm --filter <name> <script>`, e.g.
`pnpm --filter @water-run/core test:watch`.

## Per-app setup

- **[apps/site/.env.example](apps/site/.env.example)** — copy it to `apps/site/.env.local`.
  It documents the OSM OAuth2 client (the OSM sandbox by default) needed to write edits
  back, and the optional Formspree form endpoints.
- **[apps/mobile/README.md](apps/mobile/README.md)** — Expo dev builds, env vars, and EAS.

## External services

OSM Overpass, BRouter, Nominatim (geocoding), OpenFreeMap (the site's basemap) and OSM
tiles (the mobile map) — all public and rate-limited; be gentle. No keys required except
your OSM OAuth client (see `apps/site/.env.example`).

## Contributing

Pull requests welcome — the project lives at
[github.com/JamesMitofsky/rosm](https://github.com/JamesMitofsky/rosm).
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, code style, and PR conventions.

## Deploy

The site deploys to Vercel from CI only. Vercel's Git integration is disabled in
[`apps/site/vercel.json`](apps/site/vercel.json) (Vercel reads `vercel.json` from the
project's Root Directory, `apps/site`, not from the repo root):

- **Production** — a push to `main` runs [`ci.yml`](.github/workflows/ci.yml); its
  `deploy` job builds and deploys with a pinned Vercel CLI, and only after the `Quality`
  and `Build` jobs pass.
- **Previews** — comment `/deploy` on a PR from a branch of this repo
  ([`deploy-preview.yml`](.github/workflows/deploy-preview.yml)). Fork PRs are refused,
  because the build would run their code with the deploy token in reach. Every preview is
  aliased to one fixed URL (`PREVIEW_ALIAS`).

One-time setup:

- [ ] Add repo secrets: `VERCEL_TOKEN` ([create token](https://vercel.com/account/settings/tokens)),
      `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.
      Get the IDs via `vercel link` → read `.vercel/project.json` (`orgId`, `projectId`).
      Do not commit `.vercel/`.
- [ ] In the Vercel project settings, set the Root Directory to `apps/site`.
- [ ] Merge this config to `main` — `vercel.json` git settings only apply once on
      the production branch, and `/deploy` (an `issue_comment` workflow) only runs
      from the default branch.
- [ ] Enable branch protection on `main`: require the `Quality` and `Build` status
      checks to pass before merge.
