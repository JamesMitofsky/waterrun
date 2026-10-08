import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeTimeoutSignals, hangingFetch, json, text } from "../helpers/upstream";
import { postJson, routeContext } from "../helpers/route";

// lib/overpass captures OVERPASS_URL at import, so load the route fresh with a
// clean env to keep the mirror order deterministic.
let route: typeof import("@/pages/api/fountains");
beforeAll(async () => {
  delete process.env.OVERPASS_URL;
  vi.resetModules();
  route = await import("@/pages/api/fountains");
});

afterEach(() => {
  vi.useRealTimers();
});

const PUBLIC_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
const elements = [
  { type: "node", id: 1, lat: 38.9, lon: -77.03, tags: { check_date: "2026-01-01" } },
];

const get = (query: string, init?: RequestInit) =>
  route.GET(routeContext(new Request(`https://waterrun.app/api/fountains${query}`, init)));
const post = (body: unknown) =>
  route.POST(routeContext(postJson("https://waterrun.app/api/fountains", body)));

const sentQuery = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  new URLSearchParams(fetchMock.mock.calls[call][1].body as string).get("data") ?? "";

describe("GET /api/fountains", () => {
  it("answers the DC region with a CDN-cacheable list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ elements }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await get("?region=dc");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(PUBLIC_CACHE);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.json()).toEqual({
      fountains: [{ id: 1, lat: 38.9, lon: -77.03, tags: { check_date: "2026-01-01" } }],
    });
  });

  it("asks Overpass for what the public map shows: drinking water, in service or not", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await get("?region=dc");
    const q = sentQuery(fetchMock);
    expect(q).toContain('node["amenity"="drinking_water"](38.7799,-77.30462,39.01431,-76.76918);');
    expect(q).toContain('node["disused:amenity"="drinking_water"]');
  });

  it("refuses any other region without calling Overpass", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const query of ["?region=nyc", "?region=", ""]) {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect((await res.json()).error.retryable).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports rate limiting on every mirror as an uncached, retryable 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => text("Too Many Requests", 429)),
    );

    const res = await get("?region=dc");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.error.retryable).toBe(true);
    expect(body.error.message).toContain("rate limiting");
  });

  it("gives up with a 504 inside the web client's 20 s wait when Overpass hangs", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());

    const started = Date.now();
    const p = get("?region=dc");
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await p;
    expect(Date.now() - started).toBeLessThanOrEqual(15_000);
    expect(res.status).toBe(504);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).error.retryable).toBe(true);
  });

  it("falls back to the next mirror inside the deadline when the first one hangs", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(hangingFetch())
      .mockResolvedValueOnce(json({ elements }));
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const p = get("?region=dc");
    await vi.advanceTimersByTimeAsync(7_000);
    const res = await p;
    expect(Date.now() - started).toBeLessThanOrEqual(7_000);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(PUBLIC_CACHE);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ]);
  });

  it("stops calling Overpass once the visitor has gone", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();

    const p = get("?region=dc", { signal: ctrl.signal });
    ctrl.abort();
    const res = await p;
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/fountains", () => {
  const search = {
    lat: 38.9,
    lon: -77,
    radiusM: 100,
    tag: { key: "amenity", value: "drinking_water" },
  };

  it("searches for a point type the app offers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ elements }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await post(search);
    expect(res.status).toBe(200);
    expect((await res.json()).fountains).toHaveLength(1);
    expect(sentQuery(fetchMock)).toContain(
      'node["amenity"="drinking_water"](around:100,38.9,-77);',
    );
  });

  it("refuses a tag that tries to rewrite the query, before it reaches Overpass", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await post({
      ...search,
      tag: { key: "amenity", value: 'x"];node(-90,-180,90,180);out;//' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { message: "Unsupported point type", retryable: false },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a well-formed tag that no client offers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await post({ ...search, tag: { key: "building", value: "yes" } });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a body that isn't JSON with a 400, not a crash", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeDefined();
  });

  it("does not cache a fresh search", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ elements: [] })));
    const res = await post(search);
    expect(res.headers.get("Cache-Control")).toBeNull();
  });
});
