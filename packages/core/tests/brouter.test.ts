import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteError, footRoute } from "../src/brouter";
import { USER_AGENT } from "../src/identity";

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
  it("maps a target-island failure back to the offending waypoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("target island detected for section 2", { status: 400 }),
        ),
    );

    const points = [A, B, C];
    const err = await footRoute(points, false).catch((e) => e);
    expect(err).toBeInstanceOf(RouteError);
    expect(err.message).toContain("can't be reached on foot");
    expect(err.island).toEqual({ lat: C.lat, lon: C.lon });
  });

  it("resolves the island index against the loop-extended sequence", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("target island detected for section 2", { status: 400 }),
        ),
    );

    // loop seq = [A, B, A] — section 2 is the appended start.
    const err = await footRoute([A, B], true).catch((e) => e);
    expect(err.island).toEqual({ lat: A.lat, lon: A.lon });
  });

  it("clamps an out-of-range island index to the last waypoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("target island detected for section 9", { status: 400 }),
        ),
    );
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err.island).toEqual({ lat: B.lat, lon: B.lon });
  });

  it("treats an island as a route problem, not something to retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("target island detected for section 1", { status: 400 }),
        ),
    );
    const err = await footRoute([A, B], false).catch((e) => e);
    expect(err.retryable).toBe(false);
  });

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
