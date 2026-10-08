import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveRoute,
  getArchivedRoute,
  getArchivedRouteIndex,
  getArchivedRoutes,
  type ArchivedRoute,
  type RouteSnapshot,
} from "../src/routeArchive";
import { configureCore } from "../src/configure";
import type { KvPort } from "../src/ports";
import type { RunStop, StopStatus } from "../src/stores/run";
import { configureTestPorts } from "./helpers/ports";

// The original single-blob archive, and the per-route layout that replaced it.
const KEY = "run-for-maps:archive";
const INDEX_KEY = "run-for-maps:archive:index";
const routeKey = (id: string) => `run-for-maps:archive:route:${id}`;

let kv: ReturnType<typeof configureTestPorts>["kv"];
let ports: ReturnType<typeof configureTestPorts>["ports"];

const stop = (id: number, status: StopStatus): RunStop => ({
  id,
  lat: 0,
  lon: 0,
  tags: {},
  status,
});
const POOL = [{ id: 99, lat: 0.001, lon: 0.001, tags: { amenity: "drinking_water" } }];

function snap(routeId: string, index = 0, stops: RunStop[] = []): RouteSnapshot {
  return {
    routeId,
    plan: {
      start: { lat: 0, lon: 0 },
      loop: true,
      tagKey: "amenity",
      tagValue: "drinking_water",
      stops,
      vias: [],
      added: [],
      routeCoords: [],
      distanceM: 0,
      turns: [],
      index,
    },
    edits: [],
  };
}

// A run in the shape the old single-blob archive stored.
function legacyRoute(
  routeId: string,
  updatedAt: string,
  over: Partial<ArchivedRoute["plan"]> = {},
): ArchivedRoute {
  const s = snap(routeId);
  return {
    ...s,
    plan: { ...s.plan, ...over },
    startedAt: "2026-06-01T08:00:00.000Z",
    updatedAt,
  };
}

// Reconfigure core with a kv wrapping the same storage, as a relaunch would.
function relaunch(overrides: Partial<KvPort> = {}) {
  configureCore({ ...ports, kv: { ...kv, ...overrides } });
}

beforeEach(() => {
  // Fresh in-memory kv port per test (stands in for the device kv store).
  ({ kv, ports } = configureTestPorts());
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("archiveRoute", () => {
  it("inserts a new route stamped with startedAt = updatedAt", () => {
    archiveRoute(snap("r1"));
    const [r] = getArchivedRoutes();
    expect(r.routeId).toBe("r1");
    expect(r.startedAt).toBe("2026-07-04T10:00:00.000Z");
    expect(r.updatedAt).toBe("2026-07-04T10:00:00.000Z");
  });

  it("upserts the same routeId in place, keeping startedAt", () => {
    archiveRoute(snap("r1", 0));
    vi.setSystemTime(new Date("2026-07-04T11:00:00Z"));
    archiveRoute(snap("r1", 3));

    const all = getArchivedRoutes();
    expect(all).toHaveLength(1);
    expect(all[0].plan.index).toBe(3);
    expect(all[0].startedAt).toBe("2026-07-04T10:00:00.000Z");
    expect(all[0].updatedAt).toBe("2026-07-04T11:00:00.000Z");
  });

  it("keeps distinct routes side by side", () => {
    archiveRoute(snap("r1"));
    vi.setSystemTime(new Date("2026-07-04T11:00:00Z"));
    archiveRoute(snap("r2"));
    expect(getArchivedRoutes()).toHaveLength(2);
  });

  it("ignores snapshots without a routeId", () => {
    archiveRoute(snap(""));
    expect(getArchivedRoutes()).toEqual([]);
  });

  it("recovers from a corrupt legacy archive instead of throwing, and keeps it", () => {
    kv.set(KEY, "{corrupt!");
    expect(getArchivedRoutes()).toEqual([]);
    archiveRoute(snap("r1"));
    expect(getArchivedRoutes()).toHaveLength(1);
    // Nothing readable can be migrated, so nothing is thrown away either.
    expect(kv.get(KEY)).toBe("{corrupt!");
  });

  it("treats a non-array legacy payload as empty", () => {
    kv.set(KEY, JSON.stringify({ nope: true }));
    expect(getArchivedRoutes()).toEqual([]);
  });

  it("rewrites only this run's key and the index", () => {
    archiveRoute(snap("old"));
    archiveRoute(snap("r1"));
    const set = vi.spyOn(kv, "set");

    archiveRoute(snap("r1", 2));

    expect(set.mock.calls.map(([key]) => key).sort()).toEqual([INDEX_KEY, routeKey("r1")].sort());
    expect(getArchivedRoute("old")?.plan.index).toBe(0);
    expect(getArchivedRoute("r1")?.plan.index).toBe(2);
  });

  it("lists the run on its next archive when the index write failed", () => {
    archiveRoute(snap("old"));
    relaunch({
      set: (key: string, value: string) => {
        if (key === INDEX_KEY) throw new Error("disk full");
        kv.set(key, value);
      },
    });
    archiveRoute(snap("r1"));
    expect(getArchivedRouteIndex().map((s) => s.routeId)).toEqual(["old"]);

    relaunch();
    vi.setSystemTime(new Date("2026-07-04T11:00:00Z"));
    archiveRoute(snap("r1", 1));
    expect(getArchivedRouteIndex().map((s) => s.routeId)).toEqual(["r1", "old"]);
    // The first snapshot did land, so the run keeps its original start.
    expect(getArchivedRoute("r1")?.startedAt).toBe("2026-07-04T10:00:00.000Z");
  });

  it("keeps an active run's pool and drops it once the run is finished", () => {
    const stops = [stop(1, "pending"), stop(2, "pending")];
    archiveRoute({ ...snap("r1", 1, stops), plan: { ...snap("r1", 1, stops).plan, pool: POOL } });
    expect(getArchivedRoute("r1")?.plan.pool).toEqual(POOL);

    // Every stop dealt with (index past the last): the run is over.
    archiveRoute({ ...snap("r1", 2, stops), plan: { ...snap("r1", 2, stops).plan, pool: POOL } });
    const r = getArchivedRoute("r1")!;
    expect(r.plan.pool).toBeUndefined();
    expect(r.plan.stops).toEqual(stops);
    expect(kv.get(routeKey("r1"))).not.toContain('"pool"');
  });
});

describe("getArchivedRouteIndex", () => {
  it("summarizes each run, newest first, without loading the runs", () => {
    const stops = [
      stop(1, "confirm"),
      stop(2, "broken"),
      stop(3, "skipped"),
      stop(4, "pending"),
      stop(5, "removed"),
    ];
    archiveRoute({
      ...snap("old", 0, stops),
      plan: { ...snap("old", 0, stops).plan, distanceM: 4200 },
    });
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    archiveRoute(snap("new"));
    const get = vi.spyOn(kv, "get");

    const index = getArchivedRouteIndex();

    expect(index.map((s) => s.routeId)).toEqual(["new", "old"]);
    expect(index[1]).toEqual({
      routeId: "old",
      startedAt: "2026-07-04T10:00:00.000Z",
      updatedAt: "2026-07-04T10:00:00.000Z",
      distanceM: 4200,
      stopCount: 5,
      surveyedCount: 3,
    });
    expect(get.mock.calls.map(([key]) => key)).not.toContain(routeKey("old"));
  });

  it("is empty before anything was archived", () => {
    expect(getArchivedRouteIndex()).toEqual([]);
  });
});

describe("getArchivedRoute", () => {
  it("loads one run in full", () => {
    archiveRoute(snap("r1", 3));
    const r = getArchivedRoute("r1");
    expect(r?.routeId).toBe("r1");
    expect(r?.plan.index).toBe(3);
    expect(getArchivedRoute("nope")).toBeUndefined();
  });

  it("skips a corrupt run instead of throwing", () => {
    archiveRoute(snap("good"));
    archiveRoute(snap("bad"));
    kv.set(routeKey("bad"), '{"routeId":"bad","plan":');

    expect(getArchivedRoute("bad")).toBeUndefined();
    expect(getArchivedRoutes().map((r) => r.routeId)).toEqual(["good"]);
  });
});

describe("migration from the single-blob archive", () => {
  const older = legacyRoute("r-old", "2026-06-01T09:00:00.000Z", { distanceM: 1000 });
  const newer = legacyRoute("r-new", "2026-06-20T09:00:00.000Z", {
    stops: [stop(1, "confirm")],
    index: 1, // finished
    pool: POOL,
  });

  it("moves every run into the new layout, then removes the old blob", () => {
    kv.set(KEY, JSON.stringify([older, newer]));

    expect(getArchivedRouteIndex().map((s) => s.routeId)).toEqual(["r-new", "r-old"]);

    expect(getArchivedRoute("r-old")).toEqual(older);
    // History is kept whole; only a finished run's pool is dropped.
    const { pool: _pool, ...newerPlan } = newer.plan;
    expect(getArchivedRoute("r-new")).toEqual({ ...newer, plan: newerPlan });
    expect(kv.get(KEY)).toBeNull();
  });

  it("runs before the first write, so a new run joins the migrated history", () => {
    kv.set(KEY, JSON.stringify([older]));

    archiveRoute(snap("r1"));

    expect(getArchivedRoutes().map((r) => r.routeId)).toEqual(["r1", "r-old"]);
  });

  it("never overwrites a run already in the new layout", () => {
    // An interrupted migration wrote r-old, and the run moved on since.
    kv.set(KEY, JSON.stringify([older]));
    getArchivedRouteIndex();
    archiveRoute({ ...snap("r-old", 4) });
    kv.set(KEY, JSON.stringify([older]));
    relaunch();

    expect(getArchivedRoute("r-old")?.plan.index).toBe(4);
    expect(getArchivedRouteIndex()).toHaveLength(1);
    expect(kv.get(KEY)).toBeNull();
  });

  it("keeps the old blob when part of it can't be migrated", () => {
    kv.set(KEY, JSON.stringify([older, { not: "a route" }]));

    expect(getArchivedRouteIndex().map((s) => s.routeId)).toEqual(["r-old"]);
    expect(kv.get(KEY)).not.toBeNull();
  });

  it("keeps the old blob when the new layout can't be written, and finishes later", () => {
    kv.set(KEY, JSON.stringify([older, newer]));
    relaunch({
      set: (key: string, value: string) => {
        if (key === routeKey("r-old")) throw new Error("disk full");
        kv.set(key, value);
      },
    });

    // What did migrate is readable meanwhile.
    expect(getArchivedRouteIndex().map((s) => s.routeId)).toEqual(["r-new"]);
    expect(kv.get(KEY)).not.toBeNull();

    relaunch();
    expect(getArchivedRouteIndex().map((s) => s.routeId)).toEqual(["r-new", "r-old"]);
    expect(getArchivedRoute("r-old")).toEqual(older);
    expect(kv.get(KEY)).toBeNull();
  });

  it("lists a run that was stored but not yet indexed when the last attempt failed", () => {
    kv.set(KEY, JSON.stringify([older, newer]));
    // The newest run's key is written, then the index write fails (the run's
    // blob took the last free space), which stops the migration there.
    relaunch({
      set: (key: string, value: string) => {
        if (key === INDEX_KEY) throw new Error("disk full");
        kv.set(key, value);
      },
    });
    expect(getArchivedRouteIndex()).toEqual([]);
    expect(kv.get(routeKey("r-new"))).not.toBeNull();

    relaunch();
    expect(getArchivedRouteIndex().map((s) => s.routeId)).toEqual(["r-new", "r-old"]);
    const { pool: _pool, ...newerPlan } = newer.plan;
    expect(getArchivedRoute("r-new")).toEqual({ ...newer, plan: newerPlan });
    expect(getArchivedRoutes().map((r) => r.routeId)).toEqual(["r-new", "r-old"]);
    expect(kv.get(KEY)).toBeNull();
  });
});

describe("getArchivedRoutes", () => {
  it("returns newest run first", () => {
    archiveRoute(snap("old"));
    vi.setSystemTime(new Date("2026-07-04T12:00:00Z"));
    archiveRoute(snap("new"));
    vi.setSystemTime(new Date("2026-07-04T11:00:00Z"));
    archiveRoute(snap("middle"));

    expect(getArchivedRoutes().map((r) => r.routeId)).toEqual(["new", "middle", "old"]);
  });
});
