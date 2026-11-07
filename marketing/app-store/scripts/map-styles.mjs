// Cartographic styles for the store art, all drawn from OpenFreeMap's planet
// vector tiles (OpenMapTiles schema).
//
// `app` is the site's own style (apps/site/src/lib/basemap/map-style.json), so a
// recreated app screen sits on the same ground the product shows. The rest are
// art-directed: each is a palette fed through one layer recipe, so every
// direction reads the same streets in its own ink.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
export const TILEJSON = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export function appStyle() {
  const style = JSON.parse(
    readFileSync(resolve(repo, "apps/site/src/lib/basemap/map-style.json"), "utf8"),
  );
  for (const src of Object.values(style.sources)) {
    if (src.url === "/api/tiles") src.url = TILEJSON;
  }
  return style;
}

/**
 * One recipe, many inks. Palette keys:
 *  bg, water, park, road, roadMajor, minorWidth (multiplier), building (or null),
 *  path (or null), label (or null)
 */
export function inkStyle(p) {
  const w = p.widthScale ?? 1;
  const roadWidth = (base) => [
    "interpolate",
    ["exponential", 1.6],
    ["zoom"],
    11,
    base * 0.25 * w,
    14,
    base * w,
    17,
    base * 4 * w,
  ];
  const layers = [
    {
      id: "bg",
      type: "background",
      paint: { "background-color": p.bg, "background-opacity": p.bgOpacity ?? 1 },
    },
    p.park && {
      id: "park",
      type: "fill",
      source: "omt",
      "source-layer": "park",
      paint: { "fill-color": p.park, "fill-opacity": p.parkOpacity ?? 1 },
    },
    p.park && {
      id: "landcover-grass",
      type: "fill",
      source: "omt",
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["grass", "wood"]]],
      paint: { "fill-color": p.park, "fill-opacity": (p.parkOpacity ?? 1) * 0.8 },
    },
    {
      id: "water",
      type: "fill",
      source: "omt",
      "source-layer": "water",
      paint: { "fill-color": p.water, "fill-opacity": p.waterOpacity ?? 1 },
    },
    p.building && {
      id: "building",
      type: "fill",
      source: "omt",
      "source-layer": "building",
      minzoom: 13,
      paint: { "fill-color": p.building, "fill-opacity": p.buildingOpacity ?? 1 },
    },
    p.path && {
      id: "path",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["path", "track"]]],
      paint: { "line-color": p.path, "line-width": roadWidth(0.6), "line-dasharray": [2, 2] },
    },
    {
      id: "road-minor",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "tertiary"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.road,
        "line-width": roadWidth(1.4),
        "line-opacity": p.roadOpacity ?? 1,
      },
    },
    {
      id: "road-major",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "trunk", "motorway"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": p.roadMajor ?? p.road,
        "line-width": roadWidth(2.6),
        "line-opacity": p.roadOpacity ?? 1,
      },
    },
    p.label && {
      id: "street-label",
      type: "symbol",
      source: "omt",
      "source-layer": "transportation_name",
      minzoom: 14,
      layout: {
        "symbol-placement": "line",
        "text-field": ["upcase", ["get", "name"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 9,
        "text-letter-spacing": 0.2,
      },
      paint: { "text-color": p.label, "text-halo-color": p.bg, "text-halo-width": 1.5 },
    },
  ].filter(Boolean);
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { omt: { type: "vector", url: TILEJSON } },
    layers,
  };
}

export const PALETTES = {
  // Field Notes: blue ink on cream paper, the logo's own two colours.
  paper: {
    bg: "#f7f2e8",
    bgOpacity: 0,
    water: "#cfe0ee",
    park: "#e3e7d2",
    road: "#9db7d6",
    roadMajor: "#6f97c6",
    building: null,
    path: null,
    label: null,
    widthScale: 0.9,
  },
  // Night Shift: the app's run panel — near-black, grey streets, lime route.
  night: {
    bg: "#0c0d0a",
    water: "#14232e",
    park: "#121a12",
    road: "#2a2d27",
    roadMajor: "#3b3f36",
    building: "#141512",
    path: null,
    label: null,
    widthScale: 1,
  },
  // Public Works: an enamel-sign navy, streets as white engraving.
  enamel: {
    bg: "#12376b",
    water: "#0d2b55",
    park: "#174178",
    road: "#3d63a0",
    roadMajor: "#6b8cc4",
    building: null,
    path: null,
    label: null,
    widthScale: 0.9,
  },
};
