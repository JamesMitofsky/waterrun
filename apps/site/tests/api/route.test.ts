import { afterEach, describe, expect, it, vi } from "vitest";
import type { APIContext } from "astro";
import { POST } from "@/pages/api/route";

// POST /api/route validates the waypoints, then asks BRouter (global fetch,
// mocked here) for the street route.

const post = (body: unknown, raw?: string) =>
  POST({
    request: new Request("http://localhost/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
  } as unknown as APIContext) as Promise<Response>;

const A = { lat: 38.9, lon: -77.03 };
const B = { lat: 38.91, lon: -77.02 };

const brouterOk = () =>
  new Response(
    JSON.stringify({
      features: [
        {
          geometry: {
            coordinates: [
              [-77.03, 38.9],
              [-77.02, 38.91],
            ],
          },
          properties: { "track-length": "1500" },
        },
      ],
    }),
    { status: 200 },
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/route", () => {
  it("returns BRouter's route for a valid request", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(brouterOk());
    vi.stubGlobal("fetch", fetchMock);

    const r = await post({ points: [A, B], loop: false });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.distanceM).toBe(1500);
    expect(j.coords).toHaveLength(2);
    expect(fetchMock.mock.calls[0][0]).toContain("lonlats=-77.03,38.9|-77.02,38.91");
  });

  describe("rejects with 400 before calling BRouter", () => {
    const cases: [string, () => Promise<Response>, RegExp][] = [
      ["a body that isn't JSON", () => post(null, "{nope"), /isn't JSON/],
      ["a schema failure", () => post({ points: [A] }), /Invalid route request \(points: /],
      [
        "too many waypoints",
        () => post({ points: Array.from({ length: 301 }, () => A), loop: true }),
        /too many stops.*limit is 300/,
      ],
      [
        "a latitude out of range",
        () => post({ points: [A, { lat: 91, lon: 0 }], loop: false }),
        /invalid coordinates/,
      ],
      [
        "a longitude out of range",
        () => post({ points: [A, { lat: 0, lon: -181 }], loop: false }),
        /invalid coordinates/,
      ],
      [
        "waypoints spread over a region",
        // ~200 km apart (Washington to Philadelphia).
        () => post({ points: [A, { lat: 39.95, lon: -75.16 }], loop: false }),
        /too large an area/,
      ],
    ];

    it.each(cases)("%s", async (_name, send, message) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const r = await send();
      expect(r.status).toBe(400);
      const j = await r.json();
      expect(typeof j.error).toBe("string");
      expect(j.error).toMatch(message);
      expect(j.retryable).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts exactly the waypoint limit", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(brouterOk()));
      const r = await post({ points: Array.from({ length: 300 }, () => A), loop: false });
      expect(r.status).toBe(200);
    });
  });

  it("answers 503 retryable when BRouter is busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("<html>503</html>", { status: 503 })),
    );

    const r = await post({ points: [A, B], loop: true });
    expect(r.status).toBe(503);
    const j = await r.json();
    expect(j.retryable).toBe(true);
    expect(j.error).toMatch(/busy or unavailable/);
    expect(j.error).not.toContain("<");
  });

  it("answers 503 retryable when BRouter is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")));

    const r = await post({ points: [A, B], loop: true });
    expect(r.status).toBe(503);
    expect((await r.json()).retryable).toBe(true);
  });

  it("answers 502 with the unreachable point for a target island", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("target island detected for section 1", { status: 400 }),
        ),
    );

    const r = await post({ points: [A, B], loop: false });
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.island).toEqual(B);
    expect(j.retryable).toBe(false);
    expect(j.error).toMatch(/can't be reached on foot/);
  });

  it("answers 500 without leaking internals on an unexpected failure", async () => {
    // Malformed geometry makes turn extraction throw a plain TypeError.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            features: [{ geometry: { coordinates: [[0, 0], null, [0, 1]] }, properties: {} }],
          }),
          { status: 200 },
        ),
      ),
    );

    const r = await post({ points: [A, B], loop: false });
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error).toBe("Routing failed unexpectedly. Please try again.");
  });
});
