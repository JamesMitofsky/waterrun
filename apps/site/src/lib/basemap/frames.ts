/**
 * The fixed opening view of every map on the site, and the box it opens into.
 *
 * This module is the contract between two things that must agree exactly:
 * `scripts/build-map-placeholders.ts`, which renders a picture of that opening
 * view at build time, and `MapFrame.astro`, which paints that picture while
 * MapLibre is still downloading. If the two ever disagree about where a map
 * opens, the hand-off from picture to live map reads as a jump instead of a
 * dissolve.
 *
 * It is only possible to pre-render a frame because none of these views are
 * computed at runtime: every map on the site opens on a hard-coded centre and
 * zoom (`DemoRunMap.svelte` reads its own from here; `LiveFountainMap.svelte`
 * states its own, mirrored below). A map that fitted
 * itself to data it had not fetched yet would have no knowable first frame, and
 * would have to be made static first — as the café guide in the coffee-tracker
 * repo was — before any of this could apply to it.
 */

import { DC_CENTER } from "../demoRoute";

/** Identifies one map *in one place on the site*. See {@link MapFrameSpec.frame}. */
export type MapFrameId = "demo-run" | "live-fountains-dc";

export type MapFrameVariant = {
  /**
   * The media query that selects this variant, or `null` for the fallback.
   *
   * Both maps pick their opening zoom off a `matchMedia` breakpoint, so a single
   * pre-rendered frame cannot cover both sides of it — at DC's live-map
   * breakpoint the two zooms are 3.5 levels apart, which is an order of
   * magnitude of ground. `MapFrame.astro` feeds these to a `<picture>`, so the
   * browser resolves the same breakpoint the component will, before any JS runs.
   *
   * Listed mobile-first: `<picture>` takes the first `<source>` that matches.
   */
  media: string | null;
  /** [lat, lon] — the exact centre the map opens on. */
  center: [number, number];
  /** The exact zoom the map opens on, for viewports this variant matches. */
  zoom: number;
  /**
   * The picture's size, in CSS pixels — and the largest box this frame is
   * expected to fill.
   *
   * `MapFrame.astro` draws the picture at exactly this size, centred in its
   * box, and lets the box crop it: one CSS pixel of picture is one CSS pixel of
   * the live map at {@link zoom}, whatever the box's own size, so the picture
   * and the map agree on where every road and every stop is. (Scaling the
   * picture to *fit* the box instead was the failure this replaces: a map at a
   * fixed zoom answers a bigger box by showing more ground, not by drawing the
   * same view bigger, and the two drifted apart by the difference — most
   * visibly wherever the subject sits off-centre, see {@link subject}.)
   *
   * The price of that exactness is paid at the edges: a box larger than this
   * shows the frame's own paper around the picture. So the size is generous —
   * the biggest box the frame is realistically asked to fill — rather than a
   * typical one. Its ratio is also emitted as the frame's `aspect-ratio`, for a
   * frame whose caller gives it only a width.
   */
  frame: { width: number; height: number };
  /**
   * Where the map's subject sits relative to the frame's centre, in the
   * frame's CSS pixels — positive x east, positive y south. Absent when the
   * subject is centred. Fixed pixels rather than a fraction on purpose: the
   * zoom is fixed, so however large the frame is, the subject is exactly this
   * far from its centre. `MapFrame.astro` parks its loading spinner here rather
   * than dead centre, where the page may have laid copy over the map.
   */
  subject?: { x: number; y: number };
};

export type MapFrameSpec = {
  /** Human note about which component and which page this frame belongs to. */
  description: string;
  /**
   * What `MapFrame.astro` shows while the map loads.
   *
   * - `frosted`: the picture under frosted glass, with a spinner. For a frame
   *   whose picture is only the ground the map opens on — its points arrive
   *   with the map — so the wait has to read as loading. `blur` is the glass's
   *   radius in CSS pixels: raise it for more frost, lower it to show more of
   *   the map; the picture underneath is unchanged either way.
   * - `seamless`: the picture as it is, no glass and no spinner. For a frame
   *   whose placeholder is the map itself — its content drawn exactly and
   *   already moving (the hero's replay, `DemoRoutePlaceholder.astro`) — so
   *   there is no wait to signal: the live map takes over mid-motion, and the
   *   dissolve is between two pictures of the same thing.
   */
  loading: { kind: "frosted"; blur: number } | { kind: "seamless" };
  /**
   * The picture's width as a fraction of the frame's CSS width, for a frame
   * whose picture is seen unfrosted. Absent, the picture is a
   * {@link PLACEHOLDER_WIDTH} thumbnail.
   */
  placeholderScale?: number;
  variants: MapFrameVariant[];
};

/** Centre the live fountain map opens on — mirrors `LiveFountainMap.svelte`. */
const LIVE_CENTER: [number, number] = [38.8972, -77.0369];

/**
 * The box the full-screen fountain map opens into: the viewport, less the site
 * header above it. Sized for a 1920x1080 desktop and a 640px-wide phone (its
 * own breakpoint) at a tall 1000px — anything larger shows the frame's paper
 * past the picture's edge, see {@link MapFrameVariant.frame}.
 */
const LIVE_WIDE_FRAME = { width: 1920, height: 1080 };
const LIVE_NARROW_FRAME = { width: 640, height: 1000 };

/** MapLibre's vector tile size. Zoom is defined against it: world = SIZE * 2^zoom. */
export const TILE_SIZE = 512;

/**
 * How long `MapFrame.astro`'s loading overlay takes to dissolve once the map
 * underneath reports its first paint.
 *
 * Long enough to read as the frame clearing rather than as a cut, and no
 * longer: the map is already drawn and interactive by then, so every extra
 * millisecond is a finished map behind a picture of it. Defined here, beside
 * the rest of the frame contract, because a map that starts something the
 * moment it is revealed has to wait this out first.
 */
export const MAP_REVEAL_MS = 280;

/**
 * The hero frame: the landing page's first section, which the demo map fills
 * edge to edge (index.astro). The section is capped at 52rem tall (832px) and
 * the phone variant covers viewports up to 767px wide, so those are the
 * pictures' sizes; a desktop wider than 1920px shows paper past the edges.
 */
const DEMO_WIDE_FRAME = { width: 1920, height: 832 };
const DEMO_NARROW_FRAME = { width: 767, height: 832 };
const DEMO_WIDE_ZOOM = 12.05;
const DEMO_NARROW_ZOOM = 11.5;

/**
 * Where the route sits in the hero, relative to the frame's centre — positive
 * x east, positive y south, in the variant's CSS pixels at its zoom.
 *
 * The hero's copy is painted *over* the map: the headline and subtitle take the
 * right half on desktop and the top of the section on mobile. A map centred on
 * the route would put its eastern stops under the desktop headline and its
 * northern ones under the mobile subtitle, so each variant moves the route the
 * other way, into the half of the section the copy leaves clear. Sized from
 * the route's pixel extent at each zoom: on desktop the route spans about
 * 440px and clears the copy column down to a 1024px viewport; on mobile it
 * stands about 270px tall below the header and a ~210px copy block, and above
 * the wave.
 */
const DEMO_WIDE_SUBJECT = { x: -260, y: 0 };
const DEMO_NARROW_SUBJECT = { x: 0, y: 120 };
/** The centre that puts the route (`DC_CENTER`) at `subject` in the frame. */
const demoCenter = (zoom: number, subject: { x: number; y: number }) =>
  shiftCenter(DC_CENTER, zoom, { x: -subject.x, y: -subject.y });

export const MAP_FRAMES: Record<MapFrameId, MapFrameSpec> = {
  "demo-run": {
    description: "DemoRunMap in the landing hero (index.astro)",
    // The replay plays in the frame from the first paint, so the frame is the
    // map, not a stand-in for it — and the picture under it is seen as it is,
    // so it is drawn at half the frame's size: soft only against the live map
    // it dissolves into, not on its own.
    loading: { kind: "seamless" },
    placeholderScale: 0.5,
    variants: [
      {
        media: "(max-width: 767px)",
        center: demoCenter(DEMO_NARROW_ZOOM, DEMO_NARROW_SUBJECT),
        zoom: DEMO_NARROW_ZOOM,
        frame: DEMO_NARROW_FRAME,
        subject: DEMO_NARROW_SUBJECT,
      },
      {
        media: null,
        center: demoCenter(DEMO_WIDE_ZOOM, DEMO_WIDE_SUBJECT),
        zoom: DEMO_WIDE_ZOOM,
        frame: DEMO_WIDE_FRAME,
        subject: DEMO_WIDE_SUBJECT,
      },
    ],
  },
  "live-fountains-dc": {
    description: "LiveFountainMap filling the viewport on /public-drinking-fountains",
    loading: { kind: "frosted", blur: 8 },
    variants: [
      {
        // `LiveFountainMap`'s own breakpoint — note it is *not* the same one the
        // hero uses.
        media: "(max-width: 640px)",
        center: LIVE_CENTER,
        zoom: 7.8,
        frame: LIVE_NARROW_FRAME,
      },
      {
        media: null,
        center: LIVE_CENTER,
        zoom: 11.3,
        frame: LIVE_WIDE_FRAME,
      },
    ],
  },
};

/**
 * Width, in pixels, of the pre-rendered frame — a thumbnail, not a picture —
 * for a frame that does not set its own `placeholderScale`.
 *
 * For a frosted frame this is the real blur control. The image is drawn at its frame's CSS
 * size, so the ratio between the two *is* the softening: at 96px, where this
 * started, a phone frame magnified every source pixel several times and a
 * desktop one over ten, which dissolved the road network entirely and left
 * only the shape of the city — river, Mall, density gradient. The `filter` in
 * `MapFrame.astro` barely registered next to it.
 *
 * At 240 a 1920px desktop frame magnifies 8x and a phone frame about 3x, so
 * arterial roads and the park edges survive and the picture reads as the map
 * it is about to become rather than as fog. Raise it further to sharpen; the
 * cost is quadratic in bytes and every one of them is in the HTML.
 *
 * Small enough to inline is the constraint that bounds it. At a few kilobytes
 * each these ship as base64 data URIs inside the HTML, so the loading frame
 * costs no request at all — and a request is exactly what it could not afford,
 * since it would queue against the ~1MB engine chunk it exists to cover for.
 *
 * A seamless frame shows its picture unfrosted, where a thumbnail magnified
 * eight times reads as a blurred photograph rather than as the map; it states
 * a `placeholderScale` instead and pays for it in bytes.
 */
export const PLACEHOLDER_WIDTH = 240;

/** Quality the picture is encoded at. Generous — a 240px image is cheap. */
export const PLACEHOLDER_QUALITY = 75;

/**
 * The picture's pixel size for a variant of a frame: the frame's
 * `placeholderScale` of its CSS width, or {@link PLACEHOLDER_WIDTH}, at the
 * frame's aspect.
 */
export function placeholderSize(spec: MapFrameSpec, variant: MapFrameVariant) {
  const width =
    spec.placeholderScale === undefined
      ? PLACEHOLDER_WIDTH
      : Math.round(variant.frame.width * spec.placeholderScale);
  return {
    width,
    height: Math.round((width * variant.frame.height) / variant.frame.width),
  };
}

/**
 * The centre and zoom the named frame opens at, for the viewport the browser is
 * showing.
 *
 * The runtime half of the resolution `MapFrame` hands to the HTML parser: the
 * `<picture>` picks the thumbnail by the same media strings this walks. A
 * component calling this cannot open on a different view from the picture it
 * dissolves out of, which is exactly what happens when it restates the
 * breakpoint — or the centre — itself. Browser-only — it reads `matchMedia`.
 */
export function openingViewForViewport(id: MapFrameId): Pick<MapFrameVariant, "center" | "zoom"> {
  const { variants } = MAP_FRAMES[id];
  const matched = variants.find((v) => v.media !== null && window.matchMedia(v.media).matches);
  const fallback = variants.find((v) => v.media === null) ?? variants[variants.length - 1];
  const { center, zoom } = matched ?? fallback;
  return { center, zoom };
}

/**
 * Web Mercator projection into the unit square, north-west origin.
 *
 * The same projection MapLibre draws with, so pixel offsets computed here —
 * where a frame's subject sits, where its route is drawn into the loading
 * state — land where the live map puts them. Exported for `routeProgress`,
 * which measures along the route in this space for the same reason.
 */
export function projectMercator(lon: number, lat: number): [number, number] {
  return [
    (180 + lon) / 360,
    (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360,
  ];
}

/** Inverse of {@link projectMercator}: unit-square coordinates back to lon/lat. */
export function unprojectMercator(x: number, y: number): [number, number] {
  const k = ((180 - y * 360) * Math.PI) / 180;
  return [x * 360 - 180, ((Math.atan(Math.exp(k)) - Math.PI / 4) * 360) / Math.PI];
}

/**
 * A centre moved by a pixel offset at a zoom — positive x east, positive y
 * south, in the CSS pixels a map at `zoom` draws. How a frame's opening view
 * places its subject off-centre: state the subject, then say where in the box
 * it should sit, rather than hand-tuning a lat/lon until it lands there.
 */
export function shiftCenter(
  [lat, lon]: [number, number],
  zoom: number,
  by: { x: number; y: number },
): [number, number] {
  const world = TILE_SIZE * 2 ** zoom;
  const [x, y] = projectMercator(lon, lat);
  const [outLon, outLat] = unprojectMercator(x + by.x / world, y + by.y / world);
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return [r(outLat), r(outLon)];
}

/**
 * Where a point sits relative to a variant's centre, in that variant's frame
 * pixels — positive x east, positive y south.
 *
 * This is what lets the loading frame draw the real route and its stops without
 * MapLibre: the opening view is fixed at build time and the picture is centred
 * in the frame, so a point's offset from the frame's centre is knowable without
 * measuring anything and without an engine. The result is in the same
 * coordinate space as {@link MapFrameVariant.frame}, which is the space the
 * placeholder SVG's `viewBox` uses — so the overlay and the thumbnail are
 * scaled and cropped by one and the same rule.
 */
export function offsetFromCenter(
  point: { lat: number; lon: number },
  variant: MapFrameVariant,
): { x: number; y: number } {
  const world = TILE_SIZE * 2 ** variant.zoom;
  const p = projectMercator(point.lon, point.lat);
  const c = projectMercator(variant.center[1], variant.center[0]);
  return { x: (p[0] - c[0]) * world, y: (p[1] - c[1]) * world };
}

/**
 * The basemap's own background colour — `background-color` of the `background`
 * layer in `map-style.json`.
 *
 * The loading frame paints this behind the thumbnail so the first frame is never
 * the page showing through wherever the image has not decoded yet, and so that
 * what the reveal dissolves *from* is the same paper the live map draws on.
 */
export const BASEMAP_BACKGROUND = "#fbf8f3";
