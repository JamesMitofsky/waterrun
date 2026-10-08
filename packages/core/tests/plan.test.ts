import { describe, expect, it } from "vitest";
import { planRoute } from "../src/plan";
import { haversine, pathLength } from "@water-run/core/geo";
import type { Fountain } from "@water-run/core/schemas";

// All fixtures sit near (0, 0) where 0.001° ≈ 111 m in both axes, so straight-line
// distances are easy to reason about. Mirrors of the module's internal constants:
// DETOUR_FACTOR = 1.3 (budget = targetM / 1.3), PICKUP_DETOUR_M = 150.
const f = (id: number, lat: number, lon: number): Fountain => ({ id, lat, lon, tags: {} });
const start = { lat: 0, lon: 0 };
const DEG_M = 111195; // meters per degree (approx; assertions use tolerances)

describe("planRoute — no target distance", () => {
  it("returns an empty route with nothing pinned", () => {
    const res = planRoute({ start, candidates: [f(1, 0, 0.001)], loop: false });
    expect(res.ordered).toEqual([]);
    expect(res.estM).toBe(0);
    expect(res.autoIds).toEqual([]);
  });

  it("routes only the pinned marks (candidates ignored without a target)", () => {
    const pinned = f(1, 0, 0.0045); // ~500 m east
    const farCandidate = f(2, 0.045, 0.00225); // ~5 km north — huge detour
    const res = planRoute({
      start,
      candidates: [pinned, farCandidate],
      pinned: [pinned],
      loop: false,
      autoPickup: false,
    });
    expect(res.ordered.map((n) => n.fountain?.id)).toEqual([1]);
    expect(res.estM).toBeCloseTo(haversine(start, pinned), 0);
  });

  it("does not duplicate a pinned mark that is also a candidate", () => {
    const p = f(1, 0, 0.001);
    const res = planRoute({ start, candidates: [p], pinned: [p], loop: false });
    expect(res.ordered).toHaveLength(1);
    expect(res.autoIds).toEqual([]);
  });

  it("auto-picks up a leftover point a tiny detour off the route", () => {
    const pinned = f(1, 0, 0.0045); // ~500 m east
    const nearby = f(2, 0.0002, 0.00225); // ~22 m off the leg's midpoint
    const far = f(3, 0.045, 0.00225); // ~5 km off — beyond the 150 m detour cap
    const res = planRoute({
      start,
      candidates: [pinned, nearby, far],
      pinned: [pinned],
      loop: false,
    });
    expect(res.autoIds).toEqual([2]);
    expect(res.ordered.map((n) => n.fountain?.id)).toContain(2);
    expect(res.ordered.map((n) => n.fountain?.id)).not.toContain(3);
  });

  it("skips auto-pickup when disabled", () => {
    const pinned = f(1, 0, 0.0045);
    const nearby = f(2, 0.0002, 0.00225);
    const res = planRoute({
      start,
      candidates: [pinned, nearby],
      pinned: [pinned],
      loop: false,
      autoPickup: false,
    });
    expect(res.autoIds).toEqual([]);
    expect(res.ordered).toHaveLength(1);
  });
});

describe("planRoute — via-points", () => {
  it("includes vias as nodes without a fountain", () => {
    const res = planRoute({
      start,
      candidates: [],
      vias: [{ lat: 0, lon: 0.001 }],
      loop: false,
    });
    expect(res.ordered).toHaveLength(1);
    expect(res.ordered[0].fountain).toBeUndefined();
    expect(res.estM).toBeCloseTo(0.001 * DEG_M, -1);
  });

  it("anchors auto-pickup around a via-only route", () => {
    const nearby = f(9, 0.0001, 0.0005); // ~11 m off the start→via leg
    const res = planRoute({
      start,
      candidates: [nearby],
      vias: [{ lat: 0, lon: 0.001 }],
      loop: false,
    });
    expect(res.autoIds).toEqual([9]);
    expect(res.ordered).toHaveLength(2);
  });
});

describe("planRoute — target distance (greedy fill)", () => {
  it("fills nearest-first while the straight-line estimate fits target/1.3", () => {
    const c1 = f(1, 0, 0.001); // ~111 m out
    const c2 = f(2, 0, 0.002); // ~222 m out
    const c3 = f(3, 0, 0.02); // ~2.2 km out — cannot fit
    const res = planRoute({
      start,
      candidates: [c3, c1, c2], // shuffled input
      targetM: 1300, // budget = 1000 m straight-line
      loop: false,
    });
    expect(res.ordered.map((n) => n.fountain?.id).sort()).toEqual([1, 2]);
    expect(res.estM).toBeLessThanOrEqual(1000);
    expect(res.estM).toBeCloseTo(0.002 * DEG_M, -2);
  });

  it("counts the return leg against the budget when looping", () => {
    // Out-and-back to c2 alone costs ~444 m straight-line as a loop.
    const c2 = f(2, 0, 0.002);
    const notLoop = planRoute({ start, candidates: [c2], targetM: 300, loop: false });
    const loop = planRoute({ start, candidates: [c2], targetM: 300, loop: true });
    expect(notLoop.ordered).toHaveLength(1); // 222 m ≤ 300/1.3? no — 230.7 ✓
    expect(loop.ordered).toHaveLength(0); // 444 m > 230.7 ✗
  });

  it("keeps every candidate when the budget allows", () => {
    const cands = [f(1, 0, 0.001), f(2, 0, 0.002), f(3, 0.001, 0.001)];
    const res = planRoute({ start, candidates: cands, targetM: 13_000, loop: true });
    expect(res.ordered).toHaveLength(3);
  });

  it("always includes pinned marks, even past the budget", () => {
    const farPin = f(1, 0, 0.09); // ~10 km east
    const res = planRoute({
      start,
      candidates: [farPin],
      pinned: [farPin],
      targetM: 1000,
      loop: false,
    });
    expect(res.ordered.map((n) => n.fountain?.id)).toEqual([1]);
    expect(res.estM).toBeGreaterThan(1000);
  });
});

describe("planRoute — 2-opt ordering", () => {
  it("untangles a crossing pinned order into the perimeter route", () => {
    // Square corners with the start; pinned fed in a crossing order.
    const p1 = f(1, 0.001, 0); // N
    const p2 = f(2, 0.001, 0.001); // NE
    const p3 = f(3, 0, 0.001); // E
    const res = planRoute({
      start,
      candidates: [],
      pinned: [p2, p1, p3], // start→NE→N→E→start crosses itself
      loop: true,
      autoPickup: false,
    });
    // Optimal loop is the square perimeter: 4 × ~111 m.
    expect(res.estM).toBeCloseTo(4 * 0.001 * DEG_M, -1);
    const ids = res.ordered.map((n) => n.fountain?.id);
    expect([ids.join(","), ids.slice().reverse().join(",")]).toContain("1,2,3");
  });

  it("reports estM consistent with the ordered path", () => {
    const cands = [f(1, 0, 0.001), f(2, 0.001, 0.001), f(3, 0.001, 0)];
    const res = planRoute({ start, candidates: cands, targetM: 5000, loop: true });
    const pts = [start, ...res.ordered.map((n) => ({ lat: n.lat, lon: n.lon }))];
    expect(res.estM).toBeCloseTo(pathLength(pts, true), 6);
  });
});
