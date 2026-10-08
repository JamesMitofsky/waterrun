/**
 * Renders the first frame of every map on the site, once, at build time:
 *
 *   pnpm --filter @rosm/site map:placeholders
 *
 * (First run on a machine needs the browser it drives:
 * `pnpm --filter @rosm/site exec playwright install chromium`.)
 *
 * Writes `src/lib/basemap/placeholders.generated.ts` — one base64 data URI per
 * map per breakpoint — which `MapFrame.astro` shows the instant the page paints
 * and dissolves once the live map reports its first paint.
 *
 * Why this exists: nothing else on the critical path can beat the engine. Even
 * with the style inlined and the tile host preconnected, a tile cannot be drawn
 * until ~1MB of MapLibre has been fetched *and* parsed, and on this site the
 * maps are `client:only` islands, so that download does not even begin until the
 * island's own chunk has hydrated. An image is subject to none of that — it is
 * on screen in the first paint, and the real map slides in underneath it.
 *
 * Alignment is the whole game, and the reason this renders the map rather than
 * assembling a picture of it. Each variant is drawn by MapLibre itself, in a
 * headless browser, from the site's own style and OpenFreeMap's tiles, in a box
 * of the variant's `frame` size at its centre and zoom — exactly what the live
 * map draws in that box. The picture then *is* the map's opening view, so the
 * two cannot disagree about palette, land and water shapes, or where anything
 * sits. See `frames.ts` for the geometry, and re-run this after changing it or
 * `map-style.json`.
 *
 * (It used to stitch CARTO's raster Voyager tiles, the raster twin of the style.
 * Those now carry an "API KEY REQUIRED" watermark on every tile, which shrank
 * into a grid of diagonal strokes across the thumbnail — and a twin could only
 * ever approximate the style anyway.)
 *
 * Labels and icons are left out. At thumbnail scale text survives as short
 * dark strokes and nothing more, which reads as texture rather than as map.
 * Both are OpenStreetMap data; the map's own AttributionControl carries the OSM
 * credit, and with no labels nothing of the picture is readable on its own.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StyleSpecification } from "maplibre-gl";
import { chromium, type Browser } from "playwright";
import { format, resolveConfig } from "prettier";
import sharp from "sharp";
import {
  BASEMAP_BACKGROUND,
  MAP_FRAMES,
  PLACEHOLDER_QUALITY,
  placeholderSize,
  type MapFrameId,
  type MapFrameSpec,
  type MapFrameVariant,
} from "../src/lib/basemap/frames";
import rawMapStyle from "../src/lib/basemap/map-style.json" with { type: "json" };
import { OPENFREEMAP_TILEJSON } from "../src/lib/basemap/tiles";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = resolve(siteRoot, "src/lib/basemap/placeholders.generated.ts");

/** The engine's browser build — the same package and version the live maps bundle. */
const ENGINE_PATH = createRequire(import.meta.url).resolve("maplibre-gl/dist/maplibre-gl.js");

/**
 * Where the render page is served from. Nothing is listening there: the page
 * and the engine are answered from this process by `page.route`, and `.invalid`
 * is reserved never to resolve, so a request that slipped past the route fails
 * rather than reaching a real host.
 *
 * A real navigation rather than `page.setContent`, which writes into the
 * existing blank document instead of loading a new one — so the page's scripts
 * are not guaranteed to run in order, and anything injected for a new document
 * never runs at all.
 */
const PAGE_ORIGIN = "http://map-placeholder.invalid";
const ENGINE_URL = `${PAGE_ORIGIN}/maplibre-gl.js`;

/**
 * How long one variant may take to reach `idle` — every tile loaded and drawn.
 * A handful of vector tiles on a software GL renderer takes a few seconds; a
 * minute only runs out when the tile host is not answering, and failing the
 * run then beats writing a frame with holes in it.
 */
const RENDER_TIMEOUT_MS = 60_000;

/**
 * Chromium's software WebGL. A headless browser has no GPU to hand MapLibre,
 * and recent Chromium no longer falls back to SwiftShader on its own — without
 * the opt-in the context fails to create and the map never draws.
 */
const BROWSER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

/**
 * The site's style as the placeholder draws it.
 *
 * Two changes, both to what MapLibre is *given* rather than to the style file:
 * the vector source points at OpenFreeMap's TileJSON directly, because the
 * style names `/api/tiles` — the site's own proxy of that document, which does
 * not exist outside a running site; and symbol layers are dropped, see the note
 * on labels above.
 */
function placeholderStyle(): StyleSpecification {
  const style = structuredClone(rawMapStyle) as StyleSpecification;
  style.sources = {
    ...style.sources,
    carto: { type: "vector", url: OPENFREEMAP_TILEJSON },
  };
  style.layers = style.layers.filter((layer) => layer.type !== "symbol");
  return style;
}

/**
 * The page a variant renders in: a box of the frame's size and a map in it.
 *
 * The map is set up by an inline script rather than through `page.evaluate`
 * with a function. tsx compiles this file, and a function handed to the browser
 * is serialised from the *compiled* source, which can reference helpers that
 * exist only in Node. A script that is a string from the start runs in the page
 * exactly as written.
 */
function pageHtml(variant: MapFrameVariant, style: StyleSpecification) {
  const { width, height } = variant.frame;
  const [lat, lon] = variant.center;
  const options = {
    container: "map",
    style,
    center: [lon, lat],
    zoom: variant.zoom,
    interactive: false,
    attributionControl: false,
    // Tiles draw at full opacity the moment they land, so `idle` means drawn.
    fadeDuration: 0,
    // Keeps the last frame in the canvas for the screenshot to read back.
    canvasContextAttributes: { preserveDrawingBuffer: true },
  };
  // `<` escaped so nothing in the style can close the script element early.
  const optionsJson = JSON.stringify(options).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; background: ${BASEMAP_BACKGROUND}; }
      #map { width: ${width}px; height: ${height}px; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <script src="${ENGINE_URL}"></script>
    <script>
      window.mapIdle = new Promise((resolve, reject) => {
        const map = new maplibregl.Map(${optionsJson});
        map.on("error", (event) => reject(new Error(String(event.error?.message ?? event.error))));
        map.once("idle", () => resolve());
      });
    </script>
  </body>
</html>`;
}

async function renderVariant(
  browser: Browser,
  style: StyleSpecification,
  spec: MapFrameSpec,
  variant: MapFrameVariant,
) {
  const { width, height } = variant.frame;
  const out = placeholderSize(spec, variant);
  // One CSS pixel per device pixel: the picture is downscaled right after, so
  // rendering denser would only be thrown away.
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.route(`${PAGE_ORIGIN}/**`, (route) =>
      route.request().url() === ENGINE_URL
        ? route.fulfill({ path: ENGINE_PATH, contentType: "text/javascript" })
        : route.fulfill({ body: pageHtml(variant, style), contentType: "text/html" }),
    );
    await page.goto(`${PAGE_ORIGIN}/`);
    await Promise.race([
      page.evaluate("window.mapIdle"),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`map not idle after ${RENDER_TIMEOUT_MS}ms`)),
          RENDER_TIMEOUT_MS,
        ),
      ),
    ]);
    const png = await page.screenshot({ type: "png" });

    const webp = await sharp(png)
      .resize(out.width, out.height)
      .webp({ quality: PLACEHOLDER_QUALITY })
      .toBuffer();

    return {
      dataUri: `data:image/webp;base64,${webp.toString("base64")}`,
      bytes: webp.length,
      out,
    };
  } finally {
    await page.close();
  }
}

async function main() {
  const style = placeholderStyle();
  const rendered: { id: MapFrameId; media: string | null; dataUri: string }[] = [];

  const browser = await chromium.launch({ args: BROWSER_ARGS });
  try {
    for (const [id, spec] of Object.entries(MAP_FRAMES) as [
      MapFrameId,
      (typeof MAP_FRAMES)[MapFrameId],
    ][]) {
      for (const variant of spec.variants) {
        const { dataUri, bytes, out } = await renderVariant(browser, style, spec, variant);
        rendered.push({ id, media: variant.media, dataUri });
        console.log(
          `${id.padEnd(20)} ${(variant.media ?? "default").padEnd(20)} ` +
            `z${variant.zoom} ${variant.frame.width}x${variant.frame.height} -> ` +
            `${out.width}x${out.height} ${bytes}B (${(dataUri.length / 1024).toFixed(2)} KB inlined)`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  const byId = new Map<MapFrameId, { media: string | null; dataUri: string }[]>();
  for (const { id, media, dataUri } of rendered) {
    const list = byId.get(id) ?? [];
    list.push({ media, dataUri });
    byId.set(id, list);
  }

  const module = `// Generated by scripts/build-map-placeholders.ts — do not edit.
// Re-run \`pnpm --filter @rosm/site map:placeholders\` after any change to frames.ts or map-style.json.
import type { MapFrameId } from "./frames";

/**
 * The first frame of each map, per breakpoint, as an inline data URI.
 *
 * Inline rather than a file in \`public/\` because the whole point of this image
 * is to be on screen before anything else: a request for it competes with the
 * engine chunk it exists to cover for, and on a cold connection can lose. As a
 * data URI it arrives inside the HTML that references it, so there is no
 * request, no connection, and nothing to lose the race to.
 *
 * Most are thumbnails, magnified into the frame, which is why that is
 * affordable; a frame that shows its picture unfrosted draws a sharper one —
 * see placeholderSize in ./frames.
 */
export const MAP_PLACEHOLDERS: Record<MapFrameId, { media: string | null; src: string }[]> = {
${[...byId]
  .map(
    ([id, list]) =>
      `  "${id}": [\n${list
        .map(
          ({ media, dataUri }) =>
            `    { media: ${media === null ? "null" : JSON.stringify(media)}, src: "${dataUri}" },`,
        )
        .join("\n")}\n  ],`,
  )
  .join("\n")}
};
`;

  // Formatted on the way out, not left to `pnpm format`. The emitted file is
  // committed, so an unformatted emit shows up as a dirty tree on whoever runs
  // the next unrelated format.
  const prettierOptions = await resolveConfig(outFile);
  writeFileSync(outFile, await format(module, { ...prettierOptions, filepath: outFile }));

  const total = rendered.reduce((n, r) => n + r.dataUri.length, 0);
  console.log(
    `\nwrote ${outFile.replace(siteRoot + "/", "")} — ${rendered.length} frames, ${(total / 1024).toFixed(1)} KB total`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
