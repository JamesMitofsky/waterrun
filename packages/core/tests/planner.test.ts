import { beforeEach, describe, expect, it } from "vitest";
import {
  usePlanner,
  inRouteIdsOf,
  pinnedOf,
  removedOf,
  shouldAutoFindPoints,
  type Draft,
} from "../src/stores/planner";
import { useRun } from "../src/stores/run";
import { planRoute } from "../src/plan";
import { ApiTimeoutError } from "../src/apiResponse";
import type { Fountain } from "../src/schemas";
import type { Pt } from "../src/geo";
import { configureTestPorts } from "./helpers/ports";

// The planner reads apiFetch + geolocation through injected ports.
let apiFetchMock: ReturnType<typeof configureTestPorts>["apiFetch"];
let getCurrentPosition: ReturnType<typeof configureTestPorts>["getCurrentPosition"];

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const fail = (body: unknown, status = 500) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const f = (id: number, lat: number, lon: number): Fountain => ({ id, lat, lon, tags: {} });

const CENTER = { lat: 38.9, lon: -77.03 };
const FOUNTAINS = [f(1, 38.901, -77.031), f(2, 38.902, -77.032), f(3, 38.903, -77.033)];

// A minimal successful BRouter response.
const routeOk = (distanceM = 5000) =>
  ok({
    coords: [
      [-77.03, 38.9],
      [-77.031, 38.901],
    ],
    distanceM,
    turns: [],
  });

const initialState = usePlanner.getInitialState();

beforeEach(() => {
  ({ apiFetch: apiFetchMock, getCurrentPosition } = configureTestPorts());
  usePlanner.setState(initialState, true);
  useRun.getState().reset();
});

// The waypoints a POST /api/route call asked for (nth call to apiFetch).
const routedPoints = (call: number): Pt[] =>
  JSON.parse(apiFetchMock.mock.calls[call][1].body as string).points;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("findPoints", () => {
  it("fetches the pool and resets all picks from a prior route", async () => {
    usePlanner.setState({
      center: CENTER,
      pinnedIds: [9],
      excludedIds: [8],
      stops: [f(9, 1, 1)],
      hasRoute: true,
      resumable: {} as Draft,
    });
    apiFetchMock.mockResolvedValueOnce(ok({ fountains: FOUNTAINS }));

    await usePlanner.getState().findPoints();

    const s = usePlanner.getState();
    expect(s.fountains).toEqual(FOUNTAINS);
    expect(s.pinnedIds).toEqual([]);
    expect(s.excludedIds).toEqual([]);
    expect(s.stops).toEqual([]);
    expect(s.hasRoute).toBe(false);
    expect(s.resumable).toBeNull();
    expect(s.err).toBeNull();
  });

  it("surfaces a retryable Overpass failure", async () => {
    usePlanner.setState({ center: CENTER });
    apiFetchMock.mockResolvedValueOnce(
      fail({ error: { message: "overpass busy", retryable: true } }),
    );

    await usePlanner.getState().findPoints();

    const s = usePlanner.getState();
    expect(s.err).toBe("overpass busy");
    expect(s.errRetryable).toBe(true);
    expect(s.errSource).toBe("points");
    expect(s.busy).toBeNull();
  });

  it("offers a retry with a plain message when the request never got an answer", async () => {
    usePlanner.setState({ center: CENTER });
    apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    await usePlanner.getState().findPoints();

    const s = usePlanner.getState();
    expect(s.err).toBe("Couldn't reach the server. Check your connection and try again.");
    expect(s.errRetryable).toBe(true);
    expect(s.errSource).toBe("points");
    expect(s.busy).toBeNull();
  });

  it("offers a retry when the request timed out", async () => {
    usePlanner.setState({ center: CENTER });
    apiFetchMock.mockRejectedValueOnce(new ApiTimeoutError(90_000));

    await usePlanner.getState().findPoints();

    expect(usePlanner.getState().err).toMatch(/took too long/);
    expect(usePlanner.getState().errRetryable).toBe(true);
  });

  it("offers a retry for a platform's plain-text 504 instead of a JSON parse error", async () => {
    usePlanner.setState({ center: CENTER });
    apiFetchMock.mockResolvedValueOnce(
      new Response("An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT", {
        status: 504,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await usePlanner.getState().findPoints();

    const s = usePlanner.getState();
    expect(s.err).toBe("Couldn't load points. Please try again.");
    expect(s.errRetryable).toBe(true);
  });

  it("offers a retry when a captive portal answers instead of the API", async () => {
    usePlanner.setState({ center: CENTER });
    apiFetchMock.mockResolvedValueOnce(
      new Response("<html>Sign in to Free WiFi</html>", { status: 200 }),
    );

    await usePlanner.getState().findPoints();

    expect(usePlanner.getState().errRetryable).toBe(true);
    expect(usePlanner.getState().err).not.toMatch(/JSON/);
  });

  it("does not offer a retry for a request the server rejected", async () => {
    usePlanner.setState({ center: CENTER });
    apiFetchMock.mockResolvedValueOnce(
      fail({ error: { formErrors: [], fieldErrors: { radiusM: ["Too big"] } } }, 400),
    );

    await usePlanner.getState().findPoints();

    const s = usePlanner.getState();
    expect(s.err).toBe("Too big");
    expect(s.errRetryable).toBe(false);
  });

  it("caps the wait so a dead connection can't spin forever", async () => {
    usePlanner.setState({ center: CENTER });
    apiFetchMock.mockResolvedValueOnce(ok({ fountains: FOUNTAINS }));

    await usePlanner.getState().findPoints();

    expect(apiFetchMock.mock.calls[0][2]).toEqual({ timeoutMs: expect.any(Number) });
  });
});

describe("shouldAutoFindPoints", () => {
  const ready = {
    center: CENTER,
    phase: "map" as const,
    fountainsCount: 0,
    busy: null,
    err: null,
    draftReady: true,
    resumable: null,
  };

  it("searches once a start is known and nothing is loaded or pending", () => {
    expect(shouldAutoFindPoints(ready)).toBe(true);
  });

  it("waits while a saved route is being offered, or before the draft is read", () => {
    expect(shouldAutoFindPoints({ ...ready, resumable: {} as Draft })).toBe(false);
    expect(shouldAutoFindPoints({ ...ready, draftReady: false })).toBe(false);
  });

  it("stays put without a start, with points loaded, while busy, or on an error", () => {
    expect(shouldAutoFindPoints({ ...ready, center: null })).toBe(false);
    expect(shouldAutoFindPoints({ ...ready, fountainsCount: 3 })).toBe(false);
    expect(shouldAutoFindPoints({ ...ready, busy: "find" })).toBe(false);
    expect(shouldAutoFindPoints({ ...ready, err: "boom" })).toBe(false);
    expect(shouldAutoFindPoints({ ...ready, phase: "run" })).toBe(false);
  });
});

describe("planAndRoute", () => {
  it("builds stops and street geometry around a pinned point", async () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      pinnedIds: [2],
      sizeMode: "points",
    });
    apiFetchMock.mockResolvedValueOnce(routeOk(4200));

    await usePlanner.getState().planAndRoute();

    const s = usePlanner.getState();
    expect(s.hasRoute).toBe(true);
    expect(s.stops.map((x) => x.id)).toContain(2);
    expect(s.distanceM).toBe(4200);
    // BRouter coords come back [lon,lat]; the map line stores [lat,lon].
    expect(s.line[0]).toEqual([38.9, -77.03]);
  });

  it("drops a stale overlapping plan — only the latest request writes", async () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      pinnedIds: [1],
      sizeMode: "points",
    });

    let resolveFirst!: (r: Response) => void;
    apiFetchMock
      .mockImplementationOnce(() => new Promise<Response>((res) => (resolveFirst = res)))
      .mockImplementationOnce(async () => routeOk(2222));

    const first = usePlanner.getState().planAndRoute();
    const second = usePlanner.getState().planAndRoute();
    await second;
    expect(usePlanner.getState().distanceM).toBe(2222);

    // The slow first request finishes after the second — its result must be ignored.
    resolveFirst(routeOk(1111));
    await first;
    expect(usePlanner.getState().distanceM).toBe(2222);
    expect(usePlanner.getState().busy).toBeNull();
  });

  it("keeps hasRoute live when every point is removed, so adding one back re-plans", async () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      excludedIds: [1, 2, 3],
      sizeMode: "points",
      hasRoute: true,
    });

    await usePlanner.getState().planAndRoute();

    const s = usePlanner.getState();
    expect(s.stops).toEqual([]);
    expect(s.hasRoute).toBe(true);
    expect(s.err).toMatch(/No points left/);
  });
});

describe("stop toggling", () => {
  it("toggleStop pins an available point and re-plans once a route exists", async () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      sizeMode: "points",
      hasRoute: true,
    });
    apiFetchMock.mockResolvedValue(routeOk());

    usePlanner.getState().toggleStop(2);

    const s = usePlanner.getState();
    expect(s.pinnedIds).toContain(2);
    expect(inRouteIdsOf(s).has(2)).toBe(true);
    // replan fired against /api/route with the fresh pin already applied.
    expect(apiFetchMock).toHaveBeenCalledWith("/api/route", expect.anything(), {
      timeoutMs: expect.any(Number),
    });
  });

  it("toggleStop excludes an in-route point; restoreStop brings it back", () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      stops: [FOUNTAINS[0]],
      pinnedIds: [1],
    });

    usePlanner.getState().toggleStop(1);
    let s = usePlanner.getState();
    expect(s.excludedIds).toContain(1);
    expect(s.pinnedIds).not.toContain(1);
    expect(removedOf(s).map((x) => x.id)).toEqual([1]);
    expect(pinnedOf(s)).toEqual([]);

    usePlanner.getState().restoreStop(1);
    s = usePlanner.getState();
    expect(s.excludedIds).toEqual([]);
  });
});

describe("draft resume", () => {
  const draft: Draft = {
    center: CENTER,
    tag: { key: "amenity", value: "drinking_water" },
    radiusMi: 2,
    recencyMode: "stale",
    recencyMonths: 6,
    targetMi: "",
    loop: true,
    fountains: FOUNTAINS,
    pinnedIds: [2],
    excludedIds: [3],
    vias: [],
    stops: [FOUNTAINS[1]],
    line: [[38.9, -77.03]],
    distanceM: 3000,
    turns: [],
    autoCount: 0,
  };

  it("loadDraft offers a saved route only when nothing is live in memory", async () => {
    apiFetchMock.mockResolvedValueOnce(ok(draft));
    await usePlanner.getState().loadDraft();
    expect(usePlanner.getState().resumable).toEqual(draft);
    expect(usePlanner.getState().draftReady).toBe(true);

    // A route already on screen must not be clobbered by a re-offer.
    usePlanner.setState(initialState, true);
    usePlanner.setState({ stops: [FOUNTAINS[0]] });
    apiFetchMock.mockResolvedValueOnce(ok(draft));
    await usePlanner.getState().loadDraft();
    expect(usePlanner.getState().resumable).toBeNull();
  });

  it("resumeDraft restores the route and jumps to the map phase", () => {
    usePlanner.setState({ resumable: draft });

    usePlanner.getState().resumeDraft();

    const s = usePlanner.getState();
    expect(s.phase).toBe("map");
    expect(s.stops).toEqual([FOUNTAINS[1]]);
    expect(s.pinnedIds).toEqual([2]);
    expect(s.hasRoute).toBe(true);
    expect(s.resumable).toBeNull();
  });
});

describe("startRun", () => {
  it("hands the plan to the run store, persists it, drops the draft, enters run phase", async () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      stops: [FOUNTAINS[0], FOUNTAINS[1]],
      line: [
        [38.9, -77.03],
        [38.901, -77.031],
      ],
      distanceM: 3000,
    });
    apiFetchMock.mockResolvedValue(ok({ ok: true }));

    await expect(usePlanner.getState().startRun()).resolves.toBe(true);

    expect(usePlanner.getState().phase).toBe("run");
    const run = useRun.getState();
    expect(run.hasPlan).toBe(true);
    expect(run.stops.map((s) => s.id)).toEqual([1, 2]);
    expect(run.stops.every((s) => s.status === "pending")).toBe(true);
    // Plan coords flip back to BRouter's [lon,lat] order for persistence.
    expect(run.routeCoords[0]).toEqual([-77.03, 38.9]);
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/run", expect.anything());
    expect(apiFetchMock).toHaveBeenCalledWith("/api/draft", { method: "DELETE" });
  });
});

describe("resetAfterRun", () => {
  it("clears the route but keeps the start area for the next plan", () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      stops: [FOUNTAINS[0]],
      hasRoute: true,
      phase: "run",
      step: 1,
      distanceM: 3000,
    });

    usePlanner.getState().resetAfterRun();

    const s = usePlanner.getState();
    expect(s.phase).toBe("map");
    expect(s.step).toBe(2);
    expect(s.stops).toEqual([]);
    expect(s.fountains).toEqual([]);
    expect(s.hasRoute).toBe(false);
    // The start point survives so the surveyor can build another route nearby.
    expect(s.center).toEqual(CENTER);
  });
});

describe("route failures", () => {
  const withPins = () =>
    usePlanner.setState({ center: CENTER, fountains: FOUNTAINS, pinnedIds: [2] });

  it("marks a busy routing server retryable, from the route", async () => {
    withPins();
    apiFetchMock.mockResolvedValueOnce(
      fail({ error: "The routing server is busy", retryable: true }, 503),
    );

    await usePlanner.getState().planAndRoute();

    const s = usePlanner.getState();
    expect(s.err).toBe("The routing server is busy");
    expect(s.errRetryable).toBe(true);
    expect(s.errSource).toBe("route");
    expect(s.busy).toBeNull();
  });

  it("highlights an unreachable point and does not offer a retry", async () => {
    withPins();
    const island = { lat: 38.902, lon: -77.032 };
    apiFetchMock.mockResolvedValueOnce(
      fail({ error: "can't be reached on foot", island, retryable: false }, 502),
    );

    await usePlanner.getState().planAndRoute();

    const s = usePlanner.getState();
    expect(s.islandPt).toEqual(island);
    expect(s.errRetryable).toBe(false);
  });

  it("offers a retry when the routing request never got an answer", async () => {
    withPins();
    apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    await usePlanner.getState().planAndRoute();

    expect(usePlanner.getState().errRetryable).toBe(true);
    expect(usePlanner.getState().errSource).toBe("route");
  });

  it("retryRoute re-plans the same picks instead of searching again", async () => {
    withPins();
    apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    await usePlanner.getState().planAndRoute();
    apiFetchMock.mockResolvedValueOnce(routeOk(3100));

    await usePlanner.getState().retryRoute();

    const s = usePlanner.getState();
    expect(apiFetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/route", "/api/route"]);
    expect(s.pinnedIds).toEqual([2]);
    expect(s.distanceM).toBe(3100);
    expect(s.err).toBeNull();
    expect(s.errSource).toBeNull();
  });
});

describe("routeStale", () => {
  // A committed route through pins 1 and 3 (2 rides along via auto-pickup).
  async function buildRoute() {
    usePlanner.setState({ center: CENTER, fountains: FOUNTAINS, pinnedIds: [1, 3] });
    apiFetchMock.mockResolvedValueOnce(routeOk(4000));
    await usePlanner.getState().planAndRoute();
    expect(usePlanner.getState().routeStale).toBe(false);
  }

  it("blocks Start run after a failed re-plan, so the run can't use the old stops", async () => {
    await buildRoute();
    apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));

    usePlanner.getState().removeStop(3);
    await flush();

    let s = usePlanner.getState();
    expect(s.routeStale).toBe(true);
    // The previous route is still on hand, including the point just removed.
    expect(s.stops.map((f) => f.id)).toContain(3);

    await expect(usePlanner.getState().startRun()).resolves.toBe(false);

    s = usePlanner.getState();
    expect(useRun.getState().hasPlan).toBe(false);
    expect(s.phase).toBe("map");
    // The route error stays: it explains why, and carries the Retry.
    expect(s.err).toMatch(/Couldn't reach the server/);
    expect(s.errRetryable).toBe(true);
  });

  it("clears once a re-plan commits", async () => {
    await buildRoute();
    apiFetchMock.mockResolvedValueOnce(routeOk(2500));

    usePlanner.getState().removeStop(3);
    expect(usePlanner.getState().routeStale).toBe(true);
    await flush();

    const s = usePlanner.getState();
    expect(s.routeStale).toBe(false);
    expect(s.stops.map((f) => f.id)).not.toContain(3);
  });

  it("asks to wait while a re-plan is in flight", async () => {
    await buildRoute();
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));

    usePlanner.getState().addVia(38.905, -77.03);
    await expect(usePlanner.getState().startRun()).resolves.toBe(false);

    expect(useRun.getState().hasPlan).toBe(false);
    expect(usePlanner.getState().err).toMatch(/still updating/);
  });

  it("is set by every change to the selection", async () => {
    await buildRoute();
    apiFetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const changes: (() => void)[] = [
      () => usePlanner.getState().addStop(2),
      () => usePlanner.getState().removeStop(2),
      () => usePlanner.getState().restoreStop(2),
      () => usePlanner.getState().addVia(38.905, -77.03),
      () => usePlanner.getState().removeVia(0),
      () => usePlanner.getState().mapClick(38.906, -77.03),
      () => usePlanner.getState().setLoop(false),
    ];
    for (const change of changes) {
      usePlanner.setState({ routeStale: false });
      change();
      expect(usePlanner.getState().routeStale).toBe(true);
    }
  });

  it("clears when every point is removed (an empty route is still a committed one)", async () => {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      excludedIds: [1, 2, 3],
      routeStale: true,
    });
    await usePlanner.getState().planAndRoute();
    expect(usePlanner.getState().routeStale).toBe(false);
  });
});

describe("reverseRoute", () => {
  const VIA = { lat: 38.9045, lon: -77.0285 };
  const key = (p: Pt) => `${p.lat},${p.lon}`;

  async function buildViaRoute() {
    usePlanner.setState({
      center: CENTER,
      fountains: FOUNTAINS,
      pinnedIds: [1, 3],
      vias: [VIA],
    });
    apiFetchMock.mockResolvedValueOnce(routeOk(4000));
    await usePlanner.getState().planAndRoute();
  }

  it("routes the via-points too, in reverse", async () => {
    await buildViaRoute();
    const forward = routedPoints(0);
    expect(forward.map(key)).toContain(key(VIA));
    apiFetchMock.mockResolvedValueOnce(routeOk(4100));

    await usePlanner.getState().reverseRoute();

    const back = routedPoints(1);
    expect(back[0]).toEqual(CENTER);
    expect(back.slice(1).map(key)).toEqual(forward.slice(1).reverse().map(key));
    const s = usePlanner.getState();
    expect(s.reversed).toBe(true);
    expect(s.distanceM).toBe(4100);
    expect(s.stops.map((f) => f.id)).toEqual(
      s.order.filter((n) => n.fountain).map((n) => n.fountain!.id),
    );
  });

  it("keeps the reversed direction through later re-plans", async () => {
    await buildViaRoute();
    apiFetchMock.mockResolvedValue(routeOk(4100));
    await usePlanner.getState().reverseRoute();
    const reversedPoints = routedPoints(1);

    // Same selection: the re-plan routes exactly the reversed order again.
    await usePlanner.getState().retryRoute();
    expect(routedPoints(2)).toEqual(reversedPoints);

    // A changed selection is planned afresh, then turned the same way round.
    usePlanner.getState().toggleStop(2);
    await flush();
    const s = usePlanner.getState();
    const planned = planRoute({
      start: CENTER,
      candidates: FOUNTAINS.filter((f) => !s.excludedIds.includes(f.id)),
      vias: [VIA],
      pinned: pinnedOf(s),
      loop: true,
    }).ordered;
    expect(routedPoints(3).slice(1).map(key)).toEqual(planned.reverse().map(key));
  });

  it("leaves the committed route and its direction alone when it fails", async () => {
    await buildViaRoute();
    const before = usePlanner.getState();
    apiFetchMock.mockResolvedValueOnce(fail({ error: "busy", retryable: true }, 503));

    await usePlanner.getState().reverseRoute();

    const s = usePlanner.getState();
    expect(s.reversed).toBe(false);
    expect(s.order).toEqual(before.order);
    expect(s.distanceM).toBe(4000);
    expect(s.routeStale).toBe(false);
    expect(s.err).toBe("busy");
  });

  it("re-plans the current picks the other way round after a failed re-plan", async () => {
    await buildViaRoute();
    apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    usePlanner.getState().removeStop(3);
    await flush();
    expect(usePlanner.getState().routeStale).toBe(true);
    apiFetchMock.mockResolvedValueOnce(routeOk(3000));

    await usePlanner.getState().reverseRoute();

    const s = usePlanner.getState();
    expect(s.reversed).toBe(true);
    expect(s.routeStale).toBe(false);
    expect(s.stops.map((f) => f.id)).not.toContain(3);
  });

  it("is forgotten by a fresh search", async () => {
    await buildViaRoute();
    apiFetchMock.mockResolvedValueOnce(routeOk(4100));
    await usePlanner.getState().reverseRoute();
    apiFetchMock.mockResolvedValueOnce(ok({ fountains: FOUNTAINS }));

    await usePlanner.getState().findPoints();

    expect(usePlanner.getState().reversed).toBe(false);
    expect(usePlanner.getState().order).toEqual([]);
  });
});

describe("starting without a GPS fix", () => {
  it("lets a map tap set the start and clears the geolocation error", () => {
    usePlanner.setState({ phase: "map", center: null, err: "Geolocation failed: denied" });

    usePlanner.getState().mapClick(38.95, -77.05);

    const s = usePlanner.getState();
    expect(s.center).toEqual({ lat: 38.95, lon: -77.05 });
    expect(s.vias).toEqual([]);
    expect(s.err).toBeNull();
    // The map can now search on its own.
    expect(
      shouldAutoFindPoints({
        ...s,
        fountainsCount: s.fountains.length,
        draftReady: true,
      }),
    ).toBe(true);
  });

  it("drops a via-point once a start exists", () => {
    usePlanner.setState({ phase: "map", center: CENTER, fountains: FOUNTAINS });
    apiFetchMock.mockResolvedValue(routeOk());

    usePlanner.getState().mapClick(38.95, -77.05);

    expect(usePlanner.getState().center).toEqual(CENTER);
    expect(usePlanner.getState().vias).toEqual([{ lat: 38.95, lon: -77.05 }]);
  });

  it("does not let a late fix move a start the user tapped", async () => {
    let resolveFix!: (p: { lat: number; lon: number; heading: null }) => void;
    getCurrentPosition.mockReturnValueOnce(new Promise((r) => (resolveFix = r)));

    usePlanner.getState().geolocate();
    usePlanner.getState().mapClick(38.95, -77.05);
    resolveFix({ lat: 1, lon: 2, heading: null });
    await flush();

    expect(usePlanner.getState().center).toEqual({ lat: 38.95, lon: -77.05 });
  });

  it("still refines a start nobody touched", async () => {
    usePlanner.getState().recenter(CENTER); // e.g. the last known position
    getCurrentPosition.mockResolvedValueOnce({ lat: 38.9001, lon: -77.0301, heading: null });

    usePlanner.getState().geolocate();
    await flush();

    expect(usePlanner.getState().center).toEqual({ lat: 38.9001, lon: -77.0301 });
  });

  it("reports a failure only while there is no start", async () => {
    getCurrentPosition.mockRejectedValueOnce(new Error("denied"));
    usePlanner.getState().geolocate();
    await flush();
    expect(usePlanner.getState().err).toBe("Geolocation failed: denied");

    usePlanner.setState({ err: null });
    usePlanner.getState().recenter(CENTER);
    getCurrentPosition.mockRejectedValueOnce(new Error("timeout"));
    usePlanner.getState().geolocate();
    await flush();
    expect(usePlanner.getState().err).toBeNull();
  });
});

describe("resuming a draft against a racing search", () => {
  const draft: Draft = {
    center: CENTER,
    tag: { key: "amenity", value: "drinking_water" },
    radiusMi: 2,
    recencyMode: "stale",
    recencyMonths: 6,
    targetMi: "",
    loop: true,
    fountains: FOUNTAINS,
    pinnedIds: [2],
    excludedIds: [],
    vias: [],
    stops: [FOUNTAINS[1]],
    line: [[38.9, -77.03]],
    distanceM: 3000,
    turns: [],
    autoCount: 0,
  };

  it("restores the offered draft even after a search cleared the offer", async () => {
    usePlanner.setState({ center: CENTER, resumable: draft, draftReady: true });
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    void usePlanner.getState().findPoints();
    expect(usePlanner.getState().resumable).toBeNull();

    usePlanner.getState().resumeDraft(draft);

    const s = usePlanner.getState();
    expect(s.stops).toEqual([FOUNTAINS[1]]);
    expect(s.pinnedIds).toEqual([2]);
    expect(s.busy).toBeNull();
    expect(s.routeStale).toBe(false);
  });

  it("ignores the search's late reply", async () => {
    usePlanner.setState({ center: CENTER, resumable: draft, draftReady: true });
    let answer!: (r: Response) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    const search = usePlanner.getState().findPoints();

    usePlanner.getState().resumeDraft(draft);
    answer(ok({ fountains: [f(99, 39, -77)] }));
    await search;

    const s = usePlanner.getState();
    expect(s.fountains).toEqual(FOUNTAINS);
    expect(s.stops).toEqual([FOUNTAINS[1]]);
    expect(s.busy).toBeNull();
  });

  it("restores the saved direction and node order", () => {
    const order = [
      { lat: 38.95, lon: -77 },
      { ...FOUNTAINS[1], fountain: FOUNTAINS[1] },
    ];
    usePlanner.getState().resumeDraft({ ...draft, vias: [order[0]], order, reversed: true });

    expect(usePlanner.getState().order).toEqual(order);
    expect(usePlanner.getState().reversed).toBe(true);
  });

  it("rebuilds the order of an older draft without via-points from its stops", () => {
    usePlanner.getState().resumeDraft(draft);
    expect(usePlanner.getState().order).toEqual([
      { lat: FOUNTAINS[1].lat, lon: FOUNTAINS[1].lon, fountain: FOUNTAINS[1] },
    ]);
  });
});
