import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveRoute,
  getArchivedRoute,
  getArchivedRouteIndex,
  getArchivedRoutes,
  type RouteSnapshot,
} from "../src/routeArchive";
import { configureCore } from "../src/configure";
import type { KvPort } from "../src/ports";
import type { RunStop, StopStatus } from "../src/stores/run";
import { configureTestPorts } from "./helpers/ports";

// The archive's layout: one key per run, plus a small index of summaries.
const INDEX_KEY = "water-run:archive:index";
const routeKey = (id: string) => `water-run:archive:route:${id}`;

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
