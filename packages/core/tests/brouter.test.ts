import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteError, footRoute } from "../src/brouter";
import { USER_AGENT } from "../src/identity";
import { haversine, type Pt } from "../src/geo";

afterEach(() => {
  vi.useRealTimers();
});

// Minimal BRouter geojson envelope.
function geojson(
  coordinates: [number, number][],
  trackLength: string,
  messages?: string[][],
): Response {
  return new Response(
    JSON.stringify({
      features: [
        {
          geometry: { coordinates },
          properties: { "track-length": trackLength, messages },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const A = { lat: 0, lon: 0 };
const B = { lat: 0, lon: 0.001 };
const C = { lat: 0.001, lon: 0.001 };

describe("footRoute — request", () => {
  it("sends waypoints as lon,lat pairs in visit order", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      geojson(
        [
          [0, 0],
          [0.001, 0],
        ],
        "111",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await footRoute([A, B], false);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("lonlats=0,0|0.001,0");
    expect(url).not.toContain("lonlats=0,0|0.001,0|0,0");
    expect(url).toContain("format=geojson");
    expect(url).toContain("profile=");
  });

  it("identifies itself to the volunteer server", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      geojson(
        [
          [0, 0],
          [0.001, 0],
        ],
        "111",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await footRoute([A, B], false);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("User-Agent")).toBe(USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("appends the start point again when looping", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      geojson(
        [
          [0, 0],
          [0.001, 0],
          [0, 0],
        ],
        "222",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await footRoute([A, B], true);
    expect(fetchMock.mock.calls[0][0]).toContain("lonlats=0,0|0.001,0|0,0");
  });
});

describe("footRoute — response parsing", () => {
  it("returns coords and the parsed track length", async () => {
    const coords: [number, number][] = [
      [0, 0],
      [0.001, 0],
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(geojson(coords, "250")));

    const route = await footRoute([A, B], false);
    expect(route.coords).toEqual(coords);
    expect(route.distanceM).toBe(250);
  });

  it("defaults distance to 0 when track-length is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            features: [
              {
                geometry: {
                  coordinates: [
                    [0, 0],
                    [0.001, 0],
                  ],
                },
                properties: {},
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const route = await footRoute([A, B], false);
    expect(route.distanceM).toBe(0);
  });

  it("throws when BRouter returns no features", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ features: [] }), { status: 200 })),
    );
    await expect(footRoute([A, B], false)).rejects.toThrow("BRouter returned no route");
  });
});

describe("footRoute — turn extraction", () => {
  it("detects a 90° left turn and names the way turned onto", async () => {
    // Due east along the equator, then due north: one clean left turn at vertex 2.
    const coords: [number, number][] = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
    ];
    // WayTags row placed exactly at the turn's exit vertex (microdegrees).
    const messages = [
      ["Longitude", "Latitude", "WayTags"],
      ["1000", "1000", "highway=footway name=Rue de Test surface=asphalt"],
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(geojson(coords, "222", messages)));

    const route = await footRoute([A, C], false);
    expect(route.turns).toHaveLength(1);
    const turn = route.turns[0];
    expect(turn.angle).toBeCloseTo(-90, 3); // negative = left
    expect(turn.lat).toBe(0);
    expect(turn.lon).toBe(0.001);
    expect(turn.distM).toBeCloseTo(111.19, 0); // one 0.001° leg from the start
    expect(turn.name).toBe("Rue de Test");
  });

  it("omits the name when no tagged way is near the turn", async () => {
    const coords: [number, number][] = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
    ];
    // Named point ~1.1 km away — outside the 20 m snap radius.
    const messages = [
      ["Longitude", "Latitude", "WayTags"],
      ["11000", "1000", "name=Far Away"],
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(geojson(coords, "222", messages)));

    const route = await footRoute([A, C], false);
    expect(route.turns).toHaveLength(1);
    expect(route.turns[0].name).toBeUndefined();
  });

  it("nets out a micro-jog instead of reporting phantom turns", async () => {
    // Small zigzag entirely within the 15 m merge window; net heading change ~0.
    const coords: [number, number][] = [
      [0, 0],
      [0.0001, 0],
      [0.0002, 0.00001],
      [0.0003, 0],
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(geojson(coords, "33")));

    const route = await footRoute([A, B], false);
    expect(route.turns).toEqual([]);
  });

  it("keeps a route with fewer than three vertices turn-free", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        geojson(
          [
            [0, 0],
            [0.001, 0],
          ],
          "111",
        ),
      ),
    );
    const route = await footRoute([A, B], false);
    expect(route.turns).toEqual([]);
  });
});

describe("footRoute — errors", () => {
  it("marks a BRouter 5xx retryable and keeps its short text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })));
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err.island).toBeUndefined();
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("BRouter 500: boom");
    expect(err.message).toMatch(/try again/i);
  });

  it("marks rate limiting retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })));
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("(BRouter 429)");
  });

  it("reports any other 4xx as a routing failure that a retry won't fix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("no track found at pass=0\n", { status: 400 })),
    );
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("Routing failed (BRouter 400: no track found at pass=0).");
  });

  it("never passes an HTML error page or a stack trace on to the user", async () => {
    const html = "<html><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>";
    const trace = "java.lang.NullPointerException\n\tat btools.router.RoutingEngine.run";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(html, { status: 502 }))
        .mockResolvedValueOnce(new Response(trace, { status: 500 })),
    );
    const page = await footRoute([A, B], false).catch((e) => e);
    expect(page.message).not.toContain("<");
    expect(page.message).toContain("(BRouter 502)");
    const stack = await footRoute([A, B], false).catch((e) => e);
    expect(stack.message).not.toContain("NullPointerException");
  });

  it("truncates a long plain-text error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("x".repeat(1000), { status: 400 })),
    );
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err.message.length).toBeLessThan(260);
    expect(err.message).toContain("…");
  });

  it("gives up on a hung server and says to retry", async () => {
    vi.useFakeTimers();
    // A fetch that only settles once its signal aborts — a hung upstream.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const p = footRoute([A, B], false).catch((e) => e);
    await vi.advanceTimersByTimeAsync(40_000);
    const err = await p;
    expect(err).toBeInstanceOf(RouteError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/took too long/);
  });

  it("marks an unreachable server retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")));
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/Couldn't reach the routing server/);
  });

  it("marks a 200 that isn't GeoJSON retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("<html>captive portal</html>", { status: 200 })),
    );
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain("<");
  });

  it("lets the caller abandon the request", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    const p = footRoute([A, B], false, ctrl.signal).catch((e) => e);
    ctrl.abort();
    const err = await p;
    expect(err).not.toBeInstanceOf(RouteError);
    expect(err.name).toBe("AbortError");
  });
});

describe("footRoute — points cut off from the paths", () => {
  // Waypoints along the equator, ~111 m apart.
  const P = [0, 1, 2, 3, 4].map((i) => ({ lat: 0, lon: i * 0.001 }));

  // A stand-in for BRouter: routes straight through the waypoints it's sent,
  // 100 m a leg, unless a waypoint after the first lies within `radiusM` of a
  // cut-off spot. Then it answers as BRouter does for an island: with the
  // section (counted from 0) whose target that waypoint is. `when` limits the
  // islands to some calls (counted from 1). Returns the waypoints of each call.
  function fakeBrouter(
    cutOff: Pt[],
    { radiusM = 1, when = () => true }: { radiusM?: number; when?: (call: number) => boolean } = {},
  ): Pt[][] {
    const calls: Pt[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const pts = new URL(url).searchParams
          .get("lonlats")!
          .split("|")
          .map((pair) => {
            const [lon, lat] = pair.split(",").map(Number);
            return { lat, lon };
          });
        calls.push(pts);
        const idx = pts.findIndex(
          (p, i) => i > 0 && cutOff.some((c) => haversine(p, c) <= radiusM),
        );
        if (idx > 0 && when(calls.length)) {
          return new Response(`target island detected for section ${idx - 1}`, { status: 400 });
        }
        return geojson(
          pts.map((p) => [p.lon, p.lat]),
          String((pts.length - 1) * 100),
        );
      }),
    );
    return calls;
  }

  // The spot `d` meters from `to`, back towards `from`.
  const towards = (from: Pt, to: Pt, d: number): Pt => {
    const gap = haversine(from, to);
    return {
      lat: to.lat + ((from.lat - to.lat) * d) / gap,
      lon: to.lon + ((from.lon - to.lon) * d) / gap,
    };
  };

  it("routes the pieces on their own when the whole route couldn't be fitted at once", async () => {
    const calls = fakeBrouter([P[2]], { when: (n) => n === 1 });
    const route = await footRoute(P.slice(0, 4), false);
    // Section 1's target is P[2]: the pieces end at it and start from it.
    expect(calls).toEqual([P.slice(0, 4), [P[0], P[1]], [P[1], P[2]], [P[2], P[3]]]);
    expect(route.coords).toEqual(P.slice(0, 4).map((p) => [p.lon, p.lat]));
    expect(route.distanceM).toBe(300);
  });

  it("heads for the closest spot the paths reach when a point is cut off", async () => {
    fakeBrouter([P[2]]);
    const route = await footRoute(P.slice(0, 4), false);
    const near = towards(P[1], P[2], 60);
    expect(route.coords).toHaveLength(4);
    expect(route.coords[2][0]).toBeCloseTo(near.lon, 9);
    expect(route.coords[3]).toEqual([P[3].lon, P[3].lat]);
  });

  it("passes a point by when nothing near it can be reached", async () => {
    const calls = fakeBrouter([P[2]], { radiusM: 70 });
    const route = await footRoute(P.slice(0, 4), false);
    expect(route.coords).toEqual([P[0], P[1], P[3]].map((p) => [p.lon, p.lat]));
    expect(calls[calls.length - 1]).toEqual([P[1], P[3]]);
  });

  it("doesn't resend a request that was only the leg into the cut-off point", async () => {
    const calls = fakeBrouter([P[1]]);
    const route = await footRoute([P[0], P[1]], false);
    expect(calls).toHaveLength(2);
    expect(calls[1][1].lon).toBeCloseTo(towards(P[0], P[1], 60).lon, 9);
    expect(route.coords).toHaveLength(2);
  });

  it("keeps a loop's way home when the start was the point it couldn't fit", async () => {
    const calls = fakeBrouter([P[0]], { when: (n) => n === 1 });
    const route = await footRoute([P[0], P[1], P[2]], true);
    expect(calls[0]).toEqual([P[0], P[1], P[2], P[0]]);
    expect(route.coords[route.coords.length - 1]).toEqual([P[0].lon, P[0].lat]);
  });

  it("reports the point when the route can't get anywhere near it", async () => {
    fakeBrouter([P[1]], { radiusM: 70 });
    const err = await footRoute([P[0], P[1]], false).catch((e) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err.message).toContain("can't be reached on foot");
    expect(err.island).toEqual(P[1]);
    // Changing the route fixes it, not asking again.
    expect(err.retryable).toBe(false);
  });

  it("reads an out-of-range section as the last waypoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("target island detected for section 9", { status: 400 })),
    );
    const err = await footRoute([P[0], P[1]], false).catch((e) => e);
    expect(err.island).toEqual(P[1]);
  });

  it("stops working around islands after a bounded number of requests", async () => {
    // Everything past the first waypoint is cut off.
    const calls = fakeBrouter([P[0]], { radiusM: 1e6 });
    const err = await footRoute(P, false).catch((e) => e);
    expect(err).toBeInstanceOf(RouteError);
    // The first island BRouter reported (section 0's target), once the
    // allowance for working around it ran out.
    expect(err.island).toEqual(P[1]);
    expect(calls.length).toBeLessThanOrEqual(11);
  });
});
