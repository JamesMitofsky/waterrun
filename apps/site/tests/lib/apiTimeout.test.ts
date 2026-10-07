import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTimeoutError as CoreApiTimeoutError, isTransportError } from "@rosm/core/apiResponse";
import { apiFetch, ApiTimeoutError } from "@/lib/api";

afterEach(() => {
  vi.useRealTimers();
});

describe("apiFetch's timeout error", () => {
  it("is the one class core and the mobile app use", () => {
    expect(ApiTimeoutError).toBe(CoreApiTimeoutError);
  });

  it("reads as a transport failure to core's reply rules", async () => {
    vi.useFakeTimers();
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
    const p = apiFetch("/api/osm/edit", {}, { timeoutMs: 30_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const e = await p;
    expect(e).toBeInstanceOf(CoreApiTimeoutError);
    expect(isTransportError(e)).toBe(true);
  });
});
