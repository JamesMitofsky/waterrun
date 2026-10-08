import { describe, expect, it } from "vitest";
import {
  FRAME_MARGIN,
  FRAME_MIN_SIZE,
  FRAME_MIN_SPAN_M,
  frameBounds,
  framePadding,
} from "../src/mapFrame";
import { haversine, type Pt } from "../src/geo";

// Width and height in meters of a [w, s, e, n] box, measured through its middle.
function spanM([w, s, e, n]: [number, number, number, number]) {
  const midLat = (s + n) / 2;
  const midLon = (w + e) / 2;
  return {
    ew: haversine({ lat: midLat, lon: w }, { lat: midLat, lon: e }),
    ns: haversine({ lat: s, lon: midLon }, { lat: n, lon: midLon }),
  };
}

describe("frameBounds", () => {
  it("is null with nothing to frame", () => {
    expect(frameBounds([])).toBeNull();
  });

  it("returns [west, south, east, north] from lat/lon points", () => {
    const runner: Pt = { lat: 40.7, lon: -74.02 };
    const stop: Pt = { lat: 40.75, lon: -73.98 };
    expect(frameBounds([runner, stop])).toEqual([-74.02, 40.7, -73.98, 40.75]);
    // Order of the points doesn't matter.
    expect(frameBounds([stop, runner])).toEqual([-74.02, 40.7, -73.98, 40.75]);
  });

  it("covers every point of a larger set", () => {
    const pts: Pt[] = [
      { lat: 51.5, lon: -0.12 },
      { lat: 51.52, lon: -0.2 },
      { lat: 51.45, lon: -0.1 },
    ];
    expect(frameBounds(pts)).toEqual([-0.2, 51.45, -0.1, 51.52]);
  });

  it("frames a single point in a box of the minimum span, centered on it", () => {
    const p: Pt = { lat: 47.6, lon: -122.33 };
    const b = frameBounds([p])!;
    const [w, s, e, n] = b;
    expect((w + e) / 2).toBeCloseTo(p.lon, 10);
    expect((s + n) / 2).toBeCloseTo(p.lat, 10);
    const { ew, ns } = spanM(b);
    expect(ns).toBeCloseTo(FRAME_MIN_SPAN_M, -1);
    expect(ew).toBeCloseTo(FRAME_MIN_SPAN_M, -1);
  });

  it("widens a box that is narrow on one axis only", () => {
    // Two points due north of each other, 2 km apart.
    const b = frameBounds([
      { lat: 0, lon: 10 },
      { lat: 0.018, lon: 10 },
    ])!;
    expect(b[1]).toBe(0);
    expect(b[3]).toBe(0.018);
    expect(spanM(b).ew).toBeCloseTo(FRAME_MIN_SPAN_M, -1);
  });

  it("leaves a box already wider than the minimum alone", () => {
    const b = frameBounds([
      { lat: 10, lon: 10 },
      { lat: 10.01, lon: 10.01 },
    ]);
    expect(b).toEqual([10, 10, 10.01, 10.01]);
  });

  it("honors a custom minimum span", () => {
    const b = frameBounds([{ lat: 0, lon: 0 }], 1000)!;
    expect(spanM(b).ns).toBeCloseTo(1000, -1);
  });

  it("stays finite at the pole", () => {
    const b = frameBounds([{ lat: 90, lon: 0 }])!;
    expect(b.every(Number.isFinite)).toBe(true);
  });
});

describe("framePadding", () => {
  it("clears the status bar and the panel, plus the margin", () => {
    expect(framePadding({ width: 390, height: 844, coverTop: 59, coverBottom: 300 })).toEqual({
      top: 59 + FRAME_MARGIN,
      bottom: 300 + FRAME_MARGIN,
      left: FRAME_MARGIN,
      right: FRAME_MARGIN,
    });
  });

  it("keeps at least the minimum frame when the panel is very tall", () => {
    const height = 700;
    const p = framePadding({ width: 390, height, coverTop: 50, coverBottom: 600 });
    expect(height - p.top - p.bottom).toBeCloseTo(FRAME_MIN_SIZE, 6);
    // Both covered edges give way in proportion.
    expect(p.top / p.bottom).toBeCloseTo((50 + FRAME_MARGIN) / (600 + FRAME_MARGIN), 6);
  });

  it("is all zero before the map has a size", () => {
    expect(framePadding({ width: 0, height: 0, coverTop: 47, coverBottom: 0 })).toEqual({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    });
  });

  it("never pads past a map smaller than the minimum frame", () => {
    const p = framePadding({ width: 60, height: 80, coverTop: 20, coverBottom: 20 });
    expect(p).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("never returns negative padding", () => {
    const p = framePadding({ width: 300, height: 400, coverTop: 0, coverBottom: 1000 });
    expect(Math.min(p.top, p.right, p.bottom, p.left)).toBeGreaterThanOrEqual(0);
    expect(400 - p.top - p.bottom).toBeCloseTo(FRAME_MIN_SIZE, 6);
  });
});
