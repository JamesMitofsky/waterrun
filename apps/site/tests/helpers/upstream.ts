import { vi } from "vitest";

// AbortSignal.timeout runs on Node's internal timers, which vitest's fake timers
// don't replace. Route it through the (faked) global setTimeout so a test can
// advance the clock to a timeout instead of really waiting for it.
export function fakeTimeoutSignals(): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const ctrl = new AbortController();
    setTimeout(
      () =>
        ctrl.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      ms,
    );
    return ctrl.signal;
  });
}

// A fetch whose server never answers: it settles only when its signal aborts,
// rejecting with the signal's reason the way the real fetch does.
export function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

export const text = (body: string, status = 200) => new Response(body, { status });

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
