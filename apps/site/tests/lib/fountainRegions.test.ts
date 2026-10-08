import { describe, expect, it } from "vitest";
import { MAX_SEARCH_RADIUS_M, boundsHalfDiagonalM } from "@water-run/core/geo";
import { FountainsRequest } from "@water-run/core/schemas";
import { frameBounds, regionBounds } from "@/lib/fountainRegions";
import { MAP_FRAMES, offsetFromCenter } from "@/lib/basemap/frames";

const wide = MAP_FRAMES["live-fountains-dc"].variants.find((v) => v.media === null)!;

describe("frameBounds", () => {
  it("covers exactly the frame's ground, corner to corner", () => {
    const [s, w, n, e] = frameBounds(wide);
    const { width, height } = wide.frame;
    const nw = offsetFromCenter({ lat: n, lon: w }, wide);
    const se = offsetFromCenter({ lat: s, lon: e }, wide);
    // Rounded outward to ~1 m, which is a fraction of a pixel at this zoom.
    expect(nw.x).toBeCloseTo(-width / 2, 0);
    expect(nw.y).toBeCloseTo(-height / 2, 0);
    expect(se.x).toBeCloseTo(width / 2, 0);
    expect(se.y).toBeCloseTo(height / 2, 0);
    expect(nw.x).toBeLessThanOrEqual(-width / 2);
    expect(se.y).toBeGreaterThanOrEqual(height / 2);
  });
});

describe("regionBounds", () => {
  it("serves DC within the search cap, so the query is one FountainsRequest allows", () => {
    const dc = regionBounds("dc")!;
    expect(boundsHalfDiagonalM(dc)).toBeLessThanOrEqual(MAX_SEARCH_RADIUS_M);
    const parsed = FountainsRequest.safeParse({
      bounds: dc,
      tag: { key: "amenity", value: "drinking_water" },
    });
    expect(parsed.success).toBe(true);
  });

  it("centres DC on the map's own opening view", () => {
    const [s, w, n, e] = regionBounds("dc")!;
    expect(s).toBeLessThan(wide.center[0]);
    expect(n).toBeGreaterThan(wide.center[0]);
    expect(w).toBeLessThan(wide.center[1]);
    expect(e).toBeGreaterThan(wide.center[1]);
  });

  it("knows no other region", () => {
    expect(regionBounds("nyc")).toBeUndefined();
    expect(regionBounds("constructor")).toBeUndefined();
    expect(regionBounds(null)).toBeUndefined();
  });
});
