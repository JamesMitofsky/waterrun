import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "@water-run/core/identity";
import { fakeTimeoutSignals, hangingFetch } from "../helpers/upstream";

// The module captures OVERPASS_URL and the mirror list at import time, so load it
// fresh with a guaranteed-clean env to keep the endpoint order deterministic.
let mod: typeof import("@/lib/overpass");
beforeAll(async () => {
  delete process.env.OVERPASS_URL;
  vi.resetModules();
  mod = await import("@/lib/overpass");
});

afterEach(() => {
  vi.useRealTimers();
});

const tag = { key: "amenity", value: "drinking_water" };

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const errText = (status: number, body = "err") => new Response(body, { status });

describe("buildQuery", () => {
  it("targets nodes, ways and relations for the tag within a rounded radius", () => {
    const q = mod.buildQuery({ lat: 48.85, lon: 2.35, radiusM: 123.7 }, tag);
    expect(q).toContain("[out:json][timeout:15];");
    expect(q).toContain('node["amenity"="drinking_water"](around:124,48.85,2.35);');
    expect(q).toContain('way["amenity"="drinking_water"](around:124,48.85,2.35);');
    expect(q).toContain('relation["amenity"="drinking_water"](around:124,48.85,2.35);');
    expect(q).toContain("out center tags;");
    expect(q).not.toContain("disused:");
  });

  it("targets a bbox rectangle when bounds are given", () => {
    const q = mod.buildQuery({ bounds: [48.8, 2.3, 48.9, 2.4] }, tag);
    expect(q).toContain('node["amenity"="drinking_water"](48.8,2.3,48.9,2.4);');
    expect(q).toContain('way["amenity"="drinking_water"](48.8,2.3,48.9,2.4);');
    expect(q).toContain('relation["amenity"="drinking_water"](48.8,2.3,48.9,2.4);');
    expect(q).not.toContain("around:");
  });

  it("adds the disused and abandoned selectors when includeDisused is set", () => {
    const q = mod.buildQuery({ lat: 48.85, lon: 2.35, radiusM: 500 }, tag, true);
    expect(q).toContain('node["disused:amenity"="drinking_water"]');
    expect(q).toContain('node["abandoned:amenity"="drinking_water"]');
    expect(q).toContain('way["abandoned:amenity"="drinking_water"]');
    expect(q).toContain('relation["abandoned:amenity"="drinking_water"]');
    // 3 element kinds × 3 prefixes.
    expect(q.match(/\(around:/g)).toHaveLength(9);
  });

  it("escapes quotes and backslashes so a tag can't break out of its string", () => {
    const q = mod.buildQuery(
      { lat: 38.9, lon: -77, radiusM: 100 },
      {
        key: "amenity",
        value: 'x"];node(-90,-180,90,180);out;//',
      },
    );
    expect(q).toContain(
      'node["amenity"="x\\"];node(-90,-180,90,180);out;//"](around:100,38.9,-77);',
    );
    expect(mod.qlString('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it("refuses control characters in a tag", () => {
    expect(() =>
      mod.buildQuery({ lat: 0, lon: 0, radiusM: 1 }, { key: "amenity", value: "a\nb" }),
    ).toThrow();
  });
});

describe("fetchFountains — element mapping", () => {
  it("maps nodes and way/relation centers, dropping coordinate-less elements", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okJson({
        elements: [
          { type: "node", id: 1, lat: 48.1, lon: 2.1, tags: { name: "A" } },
          { type: "way", id: 2, center: { lat: 48.2, lon: 2.2 }, tags: { name: "B" } },
          { type: "relation", id: 3, tags: { name: "no coords" } },
          { type: "node", id: 4, lat: 48.4, lon: 2.4 }, // no tags
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const fountains = await mod.fetchFountains({ lat: 48.85, lon: 2.35, radiusM: 500 }, tag);
    expect(fountains).toEqual([
      { id: 1, lat: 48.1, lon: 2.1, tags: { name: "A" } },
      { id: 2, lat: 48.2, lon: 2.2, tags: { name: "B" } },
      { id: 4, lat: 48.4, lon: 2.4, tags: {} },
    ]);

    // Request shape: primary mirror, urlencoded POST carrying the query verbatim.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://overpass-api.de/api/interpreter");
    expect(init.method).toBe("POST");
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
    const sent = new URLSearchParams(init.body as string).get("data");
    expect(sent).toBe(mod.buildQuery({ lat: 48.85, lon: 2.35, radiusM: 500 }, tag));
  });

  it("applies the recency filter server-side of the API route", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const elements = [
      { type: "node", id: 1, lat: 1, lon: 1, tags: { check_date: today } }, // fresh
      { type: "node", id: 2, lat: 2, lon: 2, tags: { check_date: "2000-01-01" } }, // stale
      { type: "node", id: 3, lat: 3, lon: 3, tags: {} }, // never surveyed
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ elements }))
      .mockResolvedValueOnce(okJson({ elements }))
      .mockResolvedValueOnce(okJson({ elements }));
    vi.stubGlobal("fetch", fetchMock);

    const region = { lat: 0, lon: 0, radiusM: 500 };
    const stale = await mod.fetchFountains(region, tag, "stale", 6);
    expect(stale.map((x) => x.id)).toEqual([2, 3]);

    const fresh = await mod.fetchFountains(region, tag, "fresh", 6);
    expect(fresh.map((x) => x.id)).toEqual([1]);

    const any = await mod.fetchFountains(region, tag, "any", 6);
    expect(any.map((x) => x.id)).toEqual([1, 2, 3]);
  });
});

describe("fetchFountains — retries and mirror fallback", () => {
  it("retries a 5xx once on the same mirror, then falls through", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(504))
      .mockResolvedValueOnce(errText(504))
      .mockResolvedValueOnce(okJson({ elements: [{ type: "node", id: 7, lat: 1, lon: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const p = mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag);
    await vi.runAllTimersAsync();
    const fountains = await p;

    expect(fountains.map((x) => x.id)).toEqual([7]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Two attempts on the primary, then the first fallback mirror.
    expect(fetchMock.mock.calls[0][0]).toBe("https://overpass-api.de/api/interpreter");
    expect(fetchMock.mock.calls[1][0]).toBe("https://overpass-api.de/api/interpreter");
    expect(fetchMock.mock.calls[2][0]).toBe("https://overpass.kumi.systems/api/interpreter");
  });

  it("throws immediately on a non-retryable status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errText(400, "bad query"));
    vi.stubGlobal("fetch", fetchMock);

    const err = await mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag).catch((e) => e);
    expect(err).toBeInstanceOf(mod.OverpassError);
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
    expect(err.message).toContain("(400)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausts every mirror on rate limiting and reports a human message", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => errText(429, "Too Many Requests"));
    vi.stubGlobal("fetch", fetchMock);

    const p = mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag);
    const assertion = expect(p).rejects.toMatchObject({
      name: "OverpassError",
      retryable: true,
      status: 429,
      message: expect.stringContaining("rate limiting"),
    });
    await vi.runAllTimersAsync();
    await assertion;
    // One attempt per mirror: a 429 is never asked again on the same host.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
    ]);
  });

  it("moves to the next mirror straight after a 429", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errText(429, "Too Many Requests"))
      .mockResolvedValueOnce(okJson({ elements: [{ type: "node", id: 8, lat: 1, lon: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const fountains = await mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag);
    expect(fountains.map((x) => x.id)).toEqual([8]);
    expect(fetchMock.mock.calls[1][0]).toBe("https://overpass.kumi.systems/api/interpreter");
  });

  it("never pauses after a mirror's last attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => errText(502));
    vi.stubGlobal("fetch", fetchMock);

    const p = mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag);
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    // One 500 ms pause per mirror, between its two attempts, and none after.
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    await expect(p).rejects.toMatchObject({ status: 502, retryable: true });
  });

  it("maps request timeouts to a took-too-long message", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());

    const p = mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag);
    const assertion = expect(p).rejects.toMatchObject({
      retryable: true,
      status: null,
      timedOut: true,
      message: expect.stringContaining("took too long"),
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("maps network failures to a connectivity message", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    const p = mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag);
    const assertion = expect(p).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining("Check your connection"),
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("labels an overloaded server as busy", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => errText(504, "gateway timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const p = mod.fetchFountains({ lat: 0, lon: 0, radiusM: 500 }, tag);
    const assertion = expect(p).rejects.toMatchObject({
      message: expect.stringContaining("busy right now"),
    });
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("fetchOverpass — deadline and cancellation", () => {
  const query = "[out:json];node(1);out;";

  it("stays within the deadline when every mirror hangs", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    const p = mod.fetchOverpass(query, { deadlineMs: 25_000 });
    const assertion = expect(p).rejects.toMatchObject({ timedOut: true, retryable: true });
    await vi.runAllTimersAsync();
    await assertion;
    expect(Date.now() - started).toBeLessThanOrEqual(25_000);
    // The first mirror gets its full attempt; the second only what is left.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://overpass.kumi.systems/api/interpreter");
  });

  it("clamps an attempt to a short deadline", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const p = mod.fetchOverpass(query, { deadlineMs: 15_000 });
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(p).rejects.toMatchObject({ timedOut: true });
  });

  it("gives each attempt no more than the caller's per-attempt limit", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const p = mod.fetchOverpass(query, { deadlineMs: 15_000, attemptTimeoutMs: 7_000 });
    const assertion = expect(p).rejects.toMatchObject({ timedOut: true });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });

  it("stops trying further mirrors once the caller aborts", async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      return errText(429);
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = await mod.fetchOverpass(query, { signal: ctrl.signal }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes no request at all for an already aborted caller", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(mod.fetchOverpass(query, { signal: ctrl.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchOverpass — runtime errors reported with a 200", () => {
  const query = "[out:json];node(1);out;";
  const timedOutRemark = {
    elements: [],
    remark: 'runtime error: Query timed out in "query" at line 3 after 16 seconds.',
  };

  it("takes a runtime-error remark as a failure and tries the next mirror", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson(timedOutRemark))
      .mockResolvedValueOnce(okJson({ elements: [{ type: "node", id: 9, lat: 1, lon: 1 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const json = await mod.fetchOverpass(query);
    expect(json.elements.map((e) => e.id)).toEqual([9]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://overpass.kumi.systems/api/interpreter");
  });

  it("rejects with a retryable error when every mirror reports one", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        okJson({ elements: [], remark: 'runtime error: Query ran out of memory in "query".' }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const err = await mod.fetchOverpass(query).catch((e) => e);
    expect(err).toBeInstanceOf(mod.OverpassError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("busy");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns a result that carries a harmless remark", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okJson({ elements: [{ type: "node", id: 1 }], remark: "note" })),
    );
    expect((await mod.fetchOverpass(query)).elements).toHaveLength(1);
  });

  it("tries the next mirror when a 200 isn't JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>maintenance</html>", { status: 200 }))
      .mockResolvedValueOnce(okJson({ elements: [] }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await mod.fetchOverpass(query)).elements).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
