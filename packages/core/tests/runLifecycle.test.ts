import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeRunToResume,
  archiveRun,
  beginRun,
  closeChangesetWhenSettled,
  endRun,
  forgetStaleActiveRun,
  getActiveRunId,
  trackingAction,
} from "../src/runLifecycle";
import { getArchivedRoute, getArchivedRouteIndex } from "../src/routeArchive";
import { useRun, type RunPlan, type RunStop } from "../src/stores/run";
import { usePlanner } from "../src/stores/planner";
import { useOutbox, UNDO_WINDOW_MS, type OutboxItem } from "../src/stores/outbox";
import { configureTestPorts } from "./helpers/ports";

const ACTIVE_RUN_KEY = "rosm:active-run";

let ports: ReturnType<typeof configureTestPorts>;

const stop = (id: number): RunStop => ({ id, lat: id, lon: id, tags: {}, status: "pending" });

const plan: RunPlan = {
  start: { lat: 48.8, lon: 2.3 },
  loop: true,
  tagKey: "amenity",
  tagValue: "drinking_water",
  stops: [stop(1), stop(2), stop(3)],
  vias: [],
  pool: [{ id: 9, lat: 9, lon: 9, tags: {} }],
  added: [],
  routeCoords: [
    [2.3, 48.8],
    [2.31, 48.81],
  ],
  distanceM: 1234,
  turns: [],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const item = (over: Partial<OutboxItem>): OutboxItem => ({
  id: "x",
  nodeId: 1,
  action: "confirm",
  tagKey: "amenity",
  summary: "s",
  syncState: "sent",
  createdAt: "2026-07-04T10:00:00.000Z",
  ...over,
});

const startRun = () => {
  useRun.getState().setPlan(plan);
  beginRun();
  return useRun.getState().routeId;
};

beforeEach(() => {
  ports = configureTestPorts();
  useRun.getState().reset();
  usePlanner.setState(usePlanner.getInitialState(), true);
  useOutbox.setState({ items: [], changesetId: undefined, hydrated: true });
});

afterEach(async () => {
  await useOutbox.getState().clear();
  vi.useRealTimers();
});

describe("beginRun", () => {
  it("marks the run on screen active and archives it from the start", () => {
    const routeId = startRun();
    expect(getActiveRunId()).toBe(routeId);
    expect(getArchivedRouteIndex().map((r) => r.routeId)).toEqual([routeId]);
    expect(getArchivedRoute(routeId)?.plan.index).toBe(0);
  });

  it("doesn't rewrite the archive of a run already under way", () => {
    const routeId = startRun();
    useRun.getState().setIndex(2);
    archiveRun();
    beginRun();
    expect(getArchivedRoute(routeId)?.plan.index).toBe(2);
  });

  it("does nothing without a run", () => {
    beginRun();
    expect(getActiveRunId()).toBeNull();
    expect(getArchivedRouteIndex()).toEqual([]);
  });
});

describe("activeRunToResume", () => {
  it("picks the active run back up under its own routeId, so its archive is updated in place", () => {
    const routeId = startRun();
    useRun.getState().setStatus(1, "confirm");
    archiveRun(1);
    useRun.getState().reset(); // the process died

    const saved = activeRunToResume();
    expect(saved?.routeId).toBe(routeId);
    useRun.getState().hydrate(saved!);
    expect(useRun.getState().index).toBe(1);
    expect(useRun.getState().stops[0].status).toBe("confirm");

    archiveRun(2);
    expect(getArchivedRouteIndex().map((r) => r.routeId)).toEqual([routeId]);
    expect(getArchivedRoute(routeId)?.plan.index).toBe(2);
  });

  it("finds the active run by id, not the newest archive", () => {
    const first = startRun();
    useRun.getState().reset();
    useRun.getState().setPlan(plan);
    archiveRun(); // a newer run, archived but never made active
    ports.kv.set(ACTIVE_RUN_KEY, first);
    expect(activeRunToResume()?.routeId).toBe(first);
  });

  it("ignores a run that reached its last stop", () => {
    startRun();
    archiveRun(plan.stops.length);
    expect(activeRunToResume()).toBeNull();
  });

  it("is null with no active run, or with its archive gone", () => {
    expect(activeRunToResume()).toBeNull();
    ports.kv.set(ACTIVE_RUN_KEY, "missing");
    expect(activeRunToResume()).toBeNull();
  });
});

describe("forgetStaleActiveRun", () => {
  it("keeps a run that can still be resumed", () => {
    const routeId = startRun();
    forgetStaleActiveRun();
    expect(getActiveRunId()).toBe(routeId);
  });

  it("forgets a finished or missing run", () => {
    startRun();
    archiveRun(plan.stops.length);
    forgetStaleActiveRun();
    expect(getActiveRunId()).toBeNull();

    ports.kv.set(ACTIVE_RUN_KEY, "missing");
    forgetStaleActiveRun();
    expect(getActiveRunId()).toBeNull();
  });
});

describe("archiveRun", () => {
  it("updates the run's one archive entry in place", () => {
    const routeId = startRun();
    archiveRun(1);
    useRun.getState().setStatus(1, "confirm");
    archiveRun(2);
    expect(getArchivedRouteIndex().map((r) => r.routeId)).toEqual([routeId]);
    expect(getArchivedRoute(routeId)?.plan.index).toBe(2);
    expect(getArchivedRoute(routeId)?.plan.stops[0].status).toBe("confirm");
  });
});

describe("trackingAction", () => {
  it("tracks only an active run that a screen listens to", () => {
    expect(trackingAction({ activeRun: true, listening: true, started: false })).toBe("start");
    expect(trackingAction({ activeRun: true, listening: true, started: true })).toBeNull();
  });

  it("stops tracking that outlived its run or its screen", () => {
    for (const [activeRun, listening] of [
      [false, true],
      [true, false],
      [false, false],
    ]) {
      expect(trackingAction({ activeRun, listening, started: true })).toBe("stop");
      expect(trackingAction({ activeRun, listening, started: false })).toBeNull();
    }
  });

  it("acts on what's wanted when the platform can't say what runs", () => {
    expect(trackingAction({ activeRun: true, listening: true, started: null })).toBe("start");
    expect(trackingAction({ activeRun: false, listening: true, started: null })).toBe("stop");
  });
});

describe("endRun", () => {
  it("archives the run as finished, forgets it, and resets the run and planner", () => {
    const routeId = startRun();
    useRun.getState().setIndex(1);
    usePlanner.setState({ phase: "run", stops: plan.stops });

    expect(endRun()).toBe(routeId);

    const archived = getArchivedRoute(routeId);
    expect(archived?.plan.index).toBe(plan.stops.length);
    expect(archived?.plan.pool).toBeUndefined(); // finished runs drop their pool
    expect(getActiveRunId()).toBeNull();
    expect(useRun.getState().hasPlan).toBe(false);
    expect(usePlanner.getState().phase).toBe("map");
    expect(usePlanner.getState().stops).toEqual([]);
  });

  it("keeps every edit OSM doesn't have yet, and archives the sent ones first", () => {
    const routeId = startRun();
    const items = [
      item({ id: "sent", syncState: "sent" }),
      item({
        id: "held",
        syncState: "pending",
        holdUntil: new Date(Date.now() + 5000).toISOString(),
      }),
      item({ id: "waiting", syncState: "pending", error: "offline" }),
      item({ id: "sending", syncState: "sending" }),
      item({ id: "failed", syncState: "failed" }),
    ];
    useOutbox.setState({ items });

    endRun();

    expect(useOutbox.getState().items.map((i) => i.id)).toEqual([
      "held",
      "waiting",
      "sending",
      "failed",
    ]);
    expect(ports.outboxStorage.delete).toHaveBeenCalledWith("sent");
    expect(ports.outboxStorage.delete).toHaveBeenCalledTimes(1);
    expect(ports.outboxStorage.clear).not.toHaveBeenCalled();
    expect(getArchivedRoute(routeId)?.edits.map((i) => i.id)).toContain("sent");
  });

  it("still resets the planner when there is no run", () => {
    usePlanner.setState({ phase: "run" });
    expect(endRun()).toBeNull();
    expect(usePlanner.getState().phase).toBe("map");
    expect(getArchivedRouteIndex()).toEqual([]);
  });
});

describe("closeChangesetWhenSettled", () => {
  const closeCalls = () => ports.apiFetch.mock.calls.filter(([path]) => path === "/api/osm/close");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  it("waits out the last edit's undo hold, sends it, then closes its changeset", async () => {
    startRun();
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    ports.apiFetch.mockImplementation(async (path: string) =>
      path === "/api/osm/edit"
        ? json({ changesetId: 77, newVersion: 3, changesetUrl: "u" })
        : json({ ok: true, changesetUrl: "u" }),
    );
    endRun();

    const outcome = closeChangesetWhenSettled();
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS - 100);
    expect(closeCalls()).toHaveLength(0); // the edit is still held

    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toBe("closed");
    const paths = ports.apiFetch.mock.calls.map(([path]) => path);
    expect(paths).toEqual(["/api/osm/edit", "/api/osm/close"]);
    expect(JSON.parse(closeCalls()[0][1].body)).toEqual({ changesetId: 77 });
    expect(useOutbox.getState().changesetId).toBeUndefined();
  });

  it("leaves the changeset open when edits are still waiting", async () => {
    useOutbox.setState({ items: [item({ syncState: "pending", error: "offline" })] });
    useOutbox.getState().setChangeset(5);
    ports.apiFetch.mockRejectedValue(new TypeError("Network request failed"));

    const outcome = closeChangesetWhenSettled(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toBe("unsettled");
    expect(closeCalls()).toHaveLength(0);
    expect(useOutbox.getState().changesetId).toBe(5);
  });

  it("leaves the changeset to a run that started meanwhile", async () => {
    useOutbox.getState().setChangeset(5);
    useRun.getState().setPlan(plan);
    expect(await closeChangesetWhenSettled()).toBe("superseded");
    expect(closeCalls()).toHaveLength(0);
  });

  it("has nothing to close when no edit opened a changeset", async () => {
    expect(await closeChangesetWhenSettled()).toBe("none-open");
    expect(ports.apiFetch).not.toHaveBeenCalled();
  });

  it("keeps the id when the close fails", async () => {
    useOutbox.getState().setChangeset(5);
    ports.apiFetch.mockRejectedValueOnce(new TypeError("Network request failed"));
    expect(await closeChangesetWhenSettled()).toBe("failed");
    expect(useOutbox.getState().changesetId).toBe(5);

    ports.apiFetch.mockResolvedValueOnce(
      new Response("<html>504</html>", { status: 504, headers: { "Content-Type": "text/html" } }),
    );
    expect(await closeChangesetWhenSettled()).toBe("failed");
    expect(useOutbox.getState().changesetId).toBe(5);
  });

  it("keeps a newer changeset that an edit moved to while the close was out", async () => {
    useOutbox.getState().setChangeset(5);
    ports.apiFetch.mockImplementationOnce(async () => {
      useOutbox.getState().setChangeset(6);
      return json({ ok: true });
    });
    expect(await closeChangesetWhenSettled()).toBe("closed");
    expect(useOutbox.getState().changesetId).toBe(6);
  });
});
