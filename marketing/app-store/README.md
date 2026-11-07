# App Store kit

Screenshots, a 25-second film and the product-page copy for Water Run on iPhone.
Everything is generated from source in this folder, so a change to the app, the
copy or the art direction is a re-render rather than a redraw.

```
export/screenshots/<direction>/NN-*.jpg   1320 x 2868, the 6.9" iPhone size (ready to upload)
export/screenshots/<direction>-contact.jpg
export/video/water-run-preview-886x1920.mp4
metadata/*.txt                             the copy, one field per file, for pasting
store.config.json                          the same copy + screenshots for `eas metadata:push`
```

## Three directions, one story

Each set tells the same six-beat story (find → plan → run → survey → Lock Screen →
the public map) in a different voice. Since only the art changes, the sets can go
head to head in App Store Connect's **product page optimization**, which tests up
to three alternate screenshot sets against the original.

| Set              | Idea                                                                                                                                                                                                                  | Use          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Field Notes**  | The icon's blue ink on cream, taken all the way: pages from a runner's survey notebook. Instrument Serif headlines, DM Mono marginalia, rubber stamps, and the route laid with the logo's many-bristled "RUN" stroke. | Treatment A  |
| **Night Shift**  | The app's own run palette (near-black, lime). One lime line is the run, and it never breaks: it leaves each frame where the next picks it up, so the six read as one long run in the store's carousel.                | Treatment B  |
| **Public Works** | Fountains are civic infrastructure, so the page speaks the street's language: US sign conventions (blue services, yellow warning, orange work zone, brown recreation) in Overpass, on sidewalk concrete.              | **Original** |

All maps are real: the loop is the 23.5 km Washington, D.C. run the website
replays (`apps/site/src/lib/demoRoute.ts`), drawn on OpenFreeMap vector tiles.

## Uploading

**By hand:** App Store Connect → the app → the version → _iPhone 6.9" Display_ →
drag in `export/screenshots/public-works/*.jpg` in order. Smaller iPhone sizes are
scaled from these automatically. Paste each `metadata/*.txt` into its field.

**With EAS:** point the iOS submit profile in `apps/mobile/eas.json` at this config,
then push from `apps/mobile`:

```json
"submit": { "production": { "ios": { "metadataPath": "../../marketing/app-store/store.config.json" } } }
```

```bash
eas metadata:push
```

Screenshot paths in `store.config.json` are relative to `apps/mobile`, where EAS
resolves them. The config validates against the `eas-cli` 27.5 schema
(`APP_IPHONE_67` is App Store Connect's key for the 6.9" slot).

**Product page optimization:** App Store Connect → the app → _Product Page
Optimization_ → new test → add Field Notes and Night Shift as treatments.

## Before you submit

- **Privacy policy URL.** `store.config.json` points at `https://waterrun.app/privacy`
  (`apps/site/src/pages/privacy.astro`). Keep that page in step with what the app
  collects; App Store Connect's privacy questions should match it too.
- **The film is not an App Store preview as-is.** Apple requires previews to use
  footage captured from the app. The film uses faithful recreations and title
  cards, so it's for the website, socials and press. It is already encoded to the
  preview spec (886 x 1920, 30 fps, H.264 High, stereo 256 kbps AAC), so a cut
  rebuilt from simulator captures (`xcrun simctl io booted recordVideo`) can reuse
  the same settings in `scripts/render-video.mjs`.
- **Screens are recreations.** Each one is rebuilt in HTML from the app's
  components (strings, colours, sizes; see `src/screens.js`). Re-check them against
  a real build before shipping, because Apple expects screenshots to show the app
  in use. Two deliberate liberties: the basemap is the site's cartography (the app
  draws OSM raster tiles), and the Nearby fountain dots are illustrative, since the
  tiles carry almost no fountain data.
- **Name.** The store title is "Water Run: Fountain Map" so it ranks for
  "fountain" and "map"; the installed name stays "Water Run".
- **OpenStreetMap credit.** Map data is ODbL. The description ends with the credit
  line, and the recreated Nearby screen shows it the way the app does. If you
  reuse the art elsewhere (site, socials), carry the credit with it.

## Rebuilding

Needs Node 22+, the preinstalled Playwright Chromium, ImageMagick, ffmpeg and
Python 3 with numpy. Not part of the pnpm workspace.

```bash
cd marketing/app-store
npm install --no-package-lock          # maplibre-gl + Phosphor icons
python3 scripts/extract-data.py        # the D.C. loop, from the site
npm run maps                           # basemaps from tiles.openfreemap.org
npm run shots                          # the three screenshot sets
npm run video                          # the film (scored by scripts/score.py)
```

Open `src/screens-preview.html`, `src/field-notes.html`, `src/night-shift.html`,
`src/public-works.html` or `src/film.html` through any static server rooted at this
folder to work on a page live.

Fonts are SIL OFL (Instrument Serif, DM Mono, Bricolage Grotesque, Overpass, Inter)
plus the site's Jua. Icons are Phosphor (MIT), the set the app itself uses.
