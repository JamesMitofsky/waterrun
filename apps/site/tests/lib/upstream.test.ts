import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "@rosm/core/identity";
import {
  UpstreamNetworkError,
  UpstreamTimeoutError,
  upstreamFetch,
  upstreamSnippet,
} from "@/lib/upstream";
import { fakeTimeoutSignals, hangingFetch, text } from "../helpers/upstream";

afterEach(() => {
  vi.useRealTimers();
});

describe("upstreamFetch", () => {
  it("names the app in the User-Agent and keeps the caller's headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(text("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await upstreamFetch("https://api.example.org/x", {
      method: "PUT",
      headers: { Authorization: "Bearer t" },
      body: "b",
      timeoutMs: 1000,
    });

    expect(await res.text()).toBe("ok");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.org/x");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("b");
    expect(init.headers).toEqual({ Authorization: "Bearer t", "User-Agent": USER_AGENT });
  });

  it("passes error statuses through for the caller to judge", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(text("nope", 409)));
    const res = await upstreamFetch("https://api.example.org/x", { timeoutMs: 1000 });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe("nope");
  });

  it("handles replies that have no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const res = await upstreamFetch("https://api.example.org/x", { timeoutMs: 1000 });
    expect(res.status).toBe(204);
  });

  it("gives up with UpstreamTimeoutError when the server never answers", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());

    const p = upstreamFetch("https://api.example.org/x", { timeoutMs: 10_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("times out a reply whose body stalls after the headers", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode("partial"));
            init.signal?.addEventListener("abort", () => ctrl.error(init.signal?.reason));
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const p = upstreamFetch("https://api.example.org/x", { timeoutMs: 5_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("reports a failed connection as UpstreamNetworkError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const err = await upstreamFetch("https://api.example.org/x", { timeoutMs: 1000 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UpstreamNetworkError);
    expect(err.cause).toBeInstanceOf(TypeError);
  });

  it("rejects with the caller's own reason when the caller aborts", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctrl = new AbortController();
    const p = upstreamFetch("https://api.example.org/x", {
      timeoutMs: 60_000,
      signal: ctrl.signal,
    });
    ctrl.abort();
    const err = await p.catch((e) => e);
    expect(err).not.toBeInstanceOf(UpstreamTimeoutError);
    expect(err.name).toBe("AbortError");
  });
});

describe("upstreamSnippet", () => {
  it("keeps a short plain-text reason", () => {
    expect(upstreamSnippet("Version mismatch: Provided 3, server had: 4 of Node 1")).toBe(
      "Version mismatch: Provided 3, server had: 4 of Node 1",
    );
  });

  it("drops HTML error pages entirely", () => {
    expect(upstreamSnippet("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>")).toBe("");
    expect(upstreamSnippet("  <html><h1>Oops</h1></html>")).toBe("");
  });

  it("collapses whitespace and caps the length", () => {
    expect(upstreamSnippet("a\n\n  b\tc")).toBe("a b c");
    const long = upstreamSnippet("x".repeat(500));
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });
});
