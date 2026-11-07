// Renders every basemap the store art sits on, from real OpenFreeMap tiles,
// with MapLibre in headless Chromium (the same engine and tiles the site uses).
//
// Each job writes assets/maps/<name>.png (the map alone, no overlays) and
// assets/maps/<name>.json: the view, plus the DC run's route, its fountains and
// every drinking-water POI the tiles hold in view, projected to CSS pixels. The
// screens and posters draw routes and markers themselves from that JSON, so
// they can be animated and restyled without re-rendering a map.
//
//   node scripts/render-maps.mjs            # every job
//   node scripts/render-maps.mjs app-run    # just the named ones

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appStyle, inkStyle, PALETTES } from "./map-styles.mjs";

const require = createRequire(import.meta.url);
// Playwright is preinstalled globally in the build environment; fall back to it.
const { chromium } = (() => {
  try {
    return require("playwright");
  } catch {
    return require(
      require.resolve("playwright", { paths: [process.env.NODE_PATH ?? "/usr/lib/node_modules"] }),
    );
  }
})();

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "assets/maps");
mkdirSync(outDir, { recursive: true });
const run = JSON.parse(readFileSync(resolve(root, "src/dc-run.json"), "utf8"));
const engineJs = readFileSync(require.resolve("maplibre-gl/dist/maplibre-gl.js"));
const engineCss = readFileSync(require.resolve("maplibre-gl/dist/maplibre-gl.css"));

// Phone screens are drawn at the iPhone 17 Pro Max's 440 x 956 pt, @3x.
const PHONE = { width: 440, height: 956, dpr: 3 };

const JOBS = [
  // --- recreated app screens (the site's style) ---
  { name: "app-nearby", style: appStyle(), ...PHONE, center: [-77.0322, 38.9078], zoom: 14.95 },
  { name: "app-plan", style: appStyle(), ...PHONE, center: [-77.0335, 38.8855], zoom: 11.85 },
  { name: "app-run", style: appStyle(), ...PHONE, center: [-77.0334, 38.9052], zoom: 14.55 },
  // --- art-directed ---
  {
    name: "paper-loop",
    style: inkStyle(PALETTES.paper),
    ...PHONE,
    center: [-77.0322, 38.9045],
    zoom: 12.35,
    transparent: true,
  },
  {
    name: "paper-street",
    style: inkStyle(PALETTES.paper),
    ...PHONE,
    center: [-77.0325, 38.9095],
    zoom: 15.4,
    transparent: true,
  },
  {
    name: "night-pano",
    style: inkStyle(PALETTES.night),
    width: 2640,
    height: 956,
    dpr: 3,
    center: [-77.0322, 38.9045],
    zoom: 13.55,
  },
  {
    name: "night-tall",
    style: inkStyle(PALETTES.night),
    ...PHONE,
    center: [-77.0322, 38.9045],
    zoom: 12.35,
  },
  {
    name: "enamel-street",
    style: inkStyle(PALETTES.enamel),
    ...PHONE,
    center: [-77.0325, 38.9095],
    zoom: 15.2,
  },
  {
    name: "enamel-loop",
    style: inkStyle(PALETTES.enamel),
    ...PHONE,
    center: [-77.0322, 38.9045],
    zoom: 12.35,
  },
];

const only = process.argv.slice(2);
const jobs = only.length ? JOBS.filter((j) => only.includes(j.name)) : JOBS;

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({
  proxy,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

for (const job of jobs) {
  const t0 = Date.now();
  const ctx = await browser.newContext({
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: job.dpr,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[${job.name}] page error:`, e.message));
  await page.route("http://local.invalid/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("maplibre-gl.js"))
      return route.fulfill({ body: engineJs, contentType: "text/javascript" });
    if (url.endsWith("maplibre-gl.css"))
      return route.fulfill({ body: engineCss, contentType: "text/css" });
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><link rel="stylesheet" href="maplibre-gl.css">
        <style>html,body{margin:0;background:${job.transparent ? "transparent" : "#fff"}}#map{width:${job.width}px;height:${job.height}px}</style>
        <script src="maplibre-gl.js"></script></head><body><div id="map"></div></body></html>`,
    });
  });
  await page.goto("http://local.invalid/index.html");
  const result = await page.evaluate(
    async ({ job, run }) => {
      const map = new maplibregl.Map({
        container: "map",
        style: job.style,
        center: job.center,
        zoom: job.zoom,
        bearing: job.bearing ?? 0,
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        pixelRatio: devicePixelRatio,
        canvasContextAttributes: { preserveDrawingBuffer: true },
        preserveDrawingBuffer: true,
      });
      await new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("map never went idle")), 90_000);
        map.once("idle", () => {
          clearTimeout(timer);
          ok();
        });
      });
      const px = ([lat, lon]) => {
        const p = map.project([lon, lat]);
        return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
      };
      // Every drinking fountain the tiles hold in view (OpenMapTiles' poi layer).
      const seen = new Set();
      const pois = [];
      for (const src of Object.keys(map.getStyle().sources)) {
        let feats = [];
        try {
          feats = map.querySourceFeatures(src, { sourceLayer: "poi" });
        } catch {}
        for (const f of feats) {
          const cls = f.properties.subclass ?? f.properties.class;
          if (cls !== "drinking_water") continue;
          const [lon, lat] = f.geometry.coordinates;
          const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const [x, y] = px([lat, lon]);
          if (x < -20 || y < -20 || x > job.width + 20 || y > job.height + 20) continue;
          pois.push({ lat, lon, x, y, name: f.properties.name ?? null });
        }
      }
      const metersPerPx =
        (40075016.686 * Math.cos((job.center[1] * Math.PI) / 180)) / (512 * 2 ** job.zoom);
      return {
        name: job.name,
        width: job.width,
        height: job.height,
        dpr: devicePixelRatio,
        center: job.center,
        zoom: job.zoom,
        metersPerPx,
        route: run.trace.map(px),
        fountains: run.fountains.map((f) => ({ ...f, xy: px([f.lat, f.lon]) })),
        pois,
      };
    },
    { job, run },
  );
  await page
    .locator("#map")
    .screenshot({ path: resolve(outDir, `${job.name}.png`), omitBackground: !!job.transparent });
  writeFileSync(resolve(outDir, `${job.name}.json`), JSON.stringify(result));
  console.log(
    `${job.name}: ${result.pois.length} fountains in view, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  await ctx.close();
}
await browser.close();
