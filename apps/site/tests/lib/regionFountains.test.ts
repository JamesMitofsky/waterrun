import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fountain } from "@rosm/core/schemas";
import { fetchRegionFountains, fountainLoadErrorMessage } from "@/lib/regionFountains";

const FOUNTAIN: Fountain = {
  id: 1,
  lat: 38.8977,
  lon: -77.0365,
  tags: { amenity: "drinking_water" },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "Content-Type": "text/html" } });

// What the error card would say for a load that went this way.
async function cardFor(fetchImpl: () => Promise<Response>, online = true): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  try {
    await fetchRegionFountains("dc", { timeoutMs: 20_000 });
  } catch (e) {
    return fountainLoadErrorMessage(e, online);
  }
  throw new Error("expected the load to fail");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchRegionFountains", () => {
  it("GETs the named region with the site's cookies and returns its fountains", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ fountains: [FOUNTAIN] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchRegionFountains("dc", { timeoutMs: 20_000 })).resolves.toEqual([FOUNTAIN]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/fountains?region=dc");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("include");
  });

  it("returns an empty region as no fountains, not as a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ fountains: [] })));
    await expect(fetchRegionFountains("dc", { timeoutMs: 20_000 })).resolves.toEqual([]);
  });
});

describe("the error card's wording", () => {
  it("shows the server's own reason as it is", async () => {
    const reason =
      "OpenStreetMap's data server is rate limiting requests. Please wait a moment and try again.";
    expect(
      await cardFor(async () => json({ error: { message: reason, retryable: true } }, 503)),
    ).toBe(reason);
  });

  it("calls a 503 with no reason OpenStreetMap being busy", async () => {
    expect(await cardFor(async () => html("<html>Service Unavailable</html>", 503))).toBe(
      "OpenStreetMap is busy — try again in a moment.",
    );
  });

  it("calls the platform's 504 page a search that took too long", async () => {
    expect(await cardFor(async () => html("An error occurred with your deployment", 504))).toBe(
      "The fountain search took too long to respond. Please try again.",
    );
  });

  it("falls back to the status for any other error page, never its body", async () => {
    const card = await cardFor(async () => html("An error occurred with your deployment", 500));
    expect(card).toBe("Couldn't load fountains (status 500).");
  });

  it("treats a success that isn't JSON as something in between answering", async () => {
    // A captive portal's login page, say. Parsing it is what used to put
    // `Unexpected token '<'…` on the card.
    const card = await cardFor(async () => html("<!doctype html><title>Log in</title>", 200));
    expect(card).toBe("Couldn't reach the server. Check your connection and try again.");
    expect(card).not.toMatch(/token|JSON/i);
  });

  it("treats a reply without a fountains list as a failure", async () => {
    expect(await cardFor(async () => json({ ok: true }))).toBe(
      "Couldn't load fountains. Please try again.",
    );
    expect(await cardFor(async () => json(null))).toBe(
      "Couldn't load fountains. Please try again.",
    );
  });

  it("never shows the browser's own words for a network failure", async () => {
    for (const browserText of [
      "Load failed",
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
    ]) {
      const card = await cardFor(async () => {
        throw new TypeError(browserText);
      });
      expect(card).toBe("Couldn't reach the server. Check your connection and try again.");
    }
  });

  it("says so when the device is offline", async () => {
    const card = await cardFor(async () => {
      throw new TypeError("Load failed");
    }, false);
    expect(card).toBe("You appear to be offline. Check your connection and try again.");
  });

  it("calls a request that outlives the timeout a search that took too long", async () => {
    vi.useFakeTimers();
    // A fetch that only settles once aborted — a stalled connection.
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
    const p = fetchRegionFountains("dc", { timeoutMs: 20_000 }).catch((e) =>
      fountainLoadErrorMessage(e, true),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toBe("The fountain search took too long to respond. Please try again.");
  });

  it("falls back to a plain line for anything else, never the error's text", () => {
    const parse = new SyntaxError(`Unexpected token 'A', "An error o"... is not valid JSON`);
    expect(fountainLoadErrorMessage(parse, true)).toBe(
      "Couldn't load fountains. Please try again.",
    );
  });
});
