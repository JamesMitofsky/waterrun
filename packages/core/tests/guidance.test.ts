import { describe, expect, it } from "vitest";
import { runGuidance, guidanceWindow, ARRIVAL_RADIUS_M } from "../src/guidance";
import type { Turn } from "../src/brouter";

const turn = (distM: number, angle = 45): Turn => ({ lat: 0, lon: 0, distM, angle });

describe("runGuidance", () => {
  it("returns empty guidance with no GPS fix", () => {
    const g = runGuidance(null, { lat: 1, lon: 1 }, [], [turn(10)]);
    expect(g.distToTarget).toBeNull();
    expect(g.autoArrived).toBe(false);
    expect(g.nextTurn).toBeNull();
    expect(g.traveledM).toBe(0);
    expect(g.distToTurn).toBeNull();
  });

  it("auto-arrives when standing on the target", () => {
    const p = { lat: 40, lon: -74 };
    const g = runGuidance(p, p, [], []);
    expect(g.distToTarget).toBeLessThan(ARRIVAL_RADIUS_M);
    expect(g.autoArrived).toBe(true);
  });

  it("does not auto-arrive when far from the target", () => {
    const g = runGuidance({ lat: 40, lon: -74 }, { lat: 40.01, lon: -74 }, [], []);
    expect(g.distToTarget).toBeGreaterThan(ARRIVAL_RADIUS_M);
    expect(g.autoArrived).toBe(false);
  });

  it("picks the first turn beyond the lookahead margin", () => {
    // No usable route geometry → traveledM 0; the 3 m turn is within the 5 m
    // lookahead and skipped, the 60 m turn is next.
    const g = runGuidance({ lat: 40, lon: -74 }, { lat: 41, lon: -74 }, [], [turn(3), turn(60)]);
    expect(g.traveledM).toBe(0);
    expect(g.nextTurn?.distM).toBe(60);
    expect(g.distToTurn).toBe(60);
  });
});

describe("runGuidance on a retraced street", () => {
  // Module's flat-earth scale at the equator: meters per 0.001° of longitude/latitude.
  const M = 111.32;
  // Start → east along a street → up a dead-end spur to fountain A → back down
  // the same spur → on east → north to fountain B. [lon, lat].
  const route: [number, number][] = [
    [0, 0],
    [0.002, 0], // spur entrance
    [0.002, 0.003], // A, at the spur's tip
    [0.002, 0], // spur exit
    [0.005, 0],
    [0.005, 0.002], // B
  ];
  const A = { lat: 0.003, lon: 0.002 };
  const B = { lat: 0.002, lon: 0.005 };
  const stops = [A, B];
  const along = { A: 5 * M, spurExit: 8 * M, B: 13 * M };
  const turns: Turn[] = [
    { lat: 0, lon: 0.002, distM: 2 * M, angle: -90 }, // into the spur
    { lat: 0.003, lon: 0.002, distM: along.A, angle: 180 }, // turnaround at A
    { lat: 0, lon: 0.002, distM: along.spurExit, angle: -90 }, // out of the spur, east
    { lat: 0, lon: 0.005, distM: 12 * M, angle: -90 }, // north to B
  ];
  // Halfway down the spur, walking back out of it toward B.
  const onSpur = { lat: 0.0015, lon: 0.002 };

  it("without a window reads the way back as the way in (the bug)", () => {
    const g = runGuidance(onSpur, B, route, turns);
    expect(g.traveledM).toBeCloseTo(3.5 * M, 0);
    expect(g.nextTurn?.angle).toBe(180);
  });

  it("with the target's window places the runner on the way back", () => {
    const g = runGuidance(onSpur, B, route, turns, guidanceWindow(route, stops, 1));
    expect(g.traveledM).toBeCloseTo(6.5 * M, 0);
    expect(g.traveledM).toBeGreaterThan(along.A);
    expect(g.nextTurn?.distM).toBe(along.spurExit);
    expect(g.distToTurn).toBeCloseTo(1.5 * M, 0);
  });

  it("reads the first steps back out of the spur as the way out", () => {
    // Just past A on the way out, the way in (just before A) is exactly as near;
    // the stretch from A to B is searched first, so the way out wins.
    for (const back of [5, 10, 15, 25]) {
      const justOut = { lat: 0.003 - back / 111320, lon: 0.002 };
      const g = runGuidance(justOut, B, route, turns, guidanceWindow(route, stops, 1));
      expect(g.traveledM).toBeCloseTo(along.A + back, 0);
      expect(g.nextTurn?.distM).toBe(along.spurExit);
    }
  });

  it("still finds a runner a little short of the stop they just recorded", () => {
    // A stop is recorded from up to the arrival radius away. Short of A on the
    // way in with B already the target, the fix is off the A→B stretch by more
    // than GPS error, so the slack before A places it.
    const shortOfA = { lat: 0.003 - (ARRIVAL_RADIUS_M - 2) / 111320, lon: 0.002 };
    const straight: [number, number][] = [
      [0, 0],
      [0.002, 0],
      [0.002, 0.003],
      [0.002, 0.006],
    ];
    const g = runGuidance(shortOfA, B, straight, [], guidanceWindow(straight, [A, B], 1));
    expect(g.traveledM).toBeCloseTo(along.A - (ARRIVAL_RADIUS_M - 2), 0);
  });

  it("still reads the way in as the way in while A is the target", () => {
    const g = runGuidance(onSpur, A, route, turns, guidanceWindow(route, stops, 0));
    expect(g.traveledM).toBeCloseTo(3.5 * M, 0);
    expect(g.nextTurn?.distM).toBe(along.A);
  });

  it("re-acquires globally after an off-route jump", () => {
    // Back near the start with B still the target (e.g. A was skipped from afar):
    // nothing in B's window is within reach, so the whole route is searched.
    const nearStart = { lat: 0.0001, lon: 0.0005 };
    const g = runGuidance(nearStart, B, route, turns, guidanceWindow(route, stops, 1));
    expect(g.traveledM).toBeCloseTo(0.5 * M, 0);
    expect(g.nextTurn?.distM).toBe(2 * M);
  });
});

describe("guidanceWindow", () => {
  const route: [number, number][] = [
    [0, 0],
    [0.003, 0],
    [0, 0],
  ];
  const A = { lat: 0, lon: 0.003 };
  const atA = 0.003 * 111320;

  it("spans from the start to just past the first target", () => {
    expect(guidanceWindow(route, [A], 0)).toEqual([-Infinity, atA]);
  });

  it("runs from the last stop to the end once every stop is done", () => {
    // The way home of a single-pin out-and-back loop.
    const w = guidanceWindow(route, [A], 1);
    expect(w).toEqual([atA, Infinity]);
    const g = runGuidance({ lat: 0, lon: 0.001 }, null, route, [], w);
    expect(g.traveledM).toBeCloseTo(atA + 0.002 * 111320, 0);
  });

  it("is undefined without a route or stops", () => {
    expect(guidanceWindow([], [A], 0)).toBeUndefined();
    expect(guidanceWindow(route, [], 0)).toBeUndefined();
  });

  it("serves the same window for an equal stop list and re-projects moved stops", () => {
    const fresh: [number, number][] = route.map(([lon, lat]) => [lon, lat]);
    const first = guidanceWindow(fresh, [A], 0);
    // A status change hands over a new stops array with the same points.
    const again = guidanceWindow(fresh, [{ ...A }], 0);
    expect(again).toEqual(first);
    // A moved stop is re-projected.
    expect(guidanceWindow(fresh, [{ lat: 0, lon: 0.002 }], 0)?.[1]).toBeCloseTo(0.002 * 111320, 6);
  });
});
