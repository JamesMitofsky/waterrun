import { describe, expect, it, vi } from "vitest";
import { locateFast, shouldRefineSearch, type Fix } from "../src/locate";
import { haversine, type Pt } from "../src/geo";

// A promise the test settles by hand, to order the two fixes as it likes.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let every settled promise's handlers run.
const flush = () => new Promise((r) => setTimeout(r, 0));

const RECENT: Pt = { lat: 40.7, lon: -74 };
const FRESH: Pt = { lat: 40.701, lon: -74.001 };

function fakeSource() {
  const recent = deferred<Pt | null>();
  const current = deferred<Pt>();
  return {
    recent,
    current,
    src: { recent: () => recent.promise, current: () => current.promise },
  };
}

function run(src: ReturnType<typeof fakeSource>["src"]) {
  const fixes: Fix[] = [];
  const onError = vi.fn();
  const cancel = locateFast(src, (f) => fixes.push(f), onError);
  return { fixes, onError, cancel };
}

describe("locateFast", () => {
  it("reports the recent fix at once, then the fresh one", async () => {
    const f = fakeSource();
    const r = run(f.src);
    f.recent.resolve(RECENT);
    await flush();
    expect(r.fixes).toEqual([{ pos: RECENT, fresh: false }]);
    f.current.resolve(FRESH);
    await flush();
    expect(r.fixes).toEqual([
      { pos: RECENT, fresh: false },
      { pos: FRESH, fresh: true },
    ]);
    expect(r.onError).not.toHaveBeenCalled();
  });

  it("asks for both fixes at once, not one after the other", () => {
    const recent = vi.fn(() => new Promise<Pt | null>(() => {}));
    const current = vi.fn(() => new Promise<Pt>(() => {}));
    locateFast(
      { recent, current },
      () => {},
      () => {},
    );
    expect(recent).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledOnce();
  });

  it("waits for the fresh fix when there is no recent one", async () => {
    const f = fakeSource();
    const r = run(f.src);
    f.recent.resolve(null);
    await flush();
    expect(r.fixes).toEqual([]);
    f.current.resolve(FRESH);
    await flush();
    expect(r.fixes).toEqual([{ pos: FRESH, fresh: true }]);
  });

  it("treats a recent fix that can't be read as none", async () => {
    const f = fakeSource();
    const r = run(f.src);
    f.recent.reject(new Error("no permission"));
    f.current.resolve(FRESH);
    await flush();
    expect(r.fixes).toEqual([{ pos: FRESH, fresh: true }]);
    expect(r.onError).not.toHaveBeenCalled();
  });

  it("drops a recent fix that arrives after the fresh one", async () => {
    const f = fakeSource();
    const r = run(f.src);
    f.current.resolve(FRESH);
    await flush();
    f.recent.resolve(RECENT);
    await flush();
    expect(r.fixes).toEqual([{ pos: FRESH, fresh: true }]);
  });

  it("doesn't report a failed fresh fix once a recent one is showing", async () => {
    const f = fakeSource();
    const r = run(f.src);
    f.recent.resolve(RECENT);
    await flush();
    f.current.reject(new Error("timed out"));
    await flush();
    expect(r.fixes).toEqual([{ pos: RECENT, fresh: false }]);
    expect(r.onError).not.toHaveBeenCalled();
  });

  it("uses a recent fix that settles after the fresh one failed", async () => {
    const f = fakeSource();
    const r = run(f.src);
    f.current.reject(new Error("timed out"));
    await flush();
    expect(r.onError).not.toHaveBeenCalled();
    f.recent.resolve(RECENT);
    await flush();
    expect(r.fixes).toEqual([{ pos: RECENT, fresh: false }]);
    expect(r.onError).not.toHaveBeenCalled();
  });

  it("reports the error when neither fix came", async () => {
    const f = fakeSource();
    const r = run(f.src);
    const denied = new Error("Location permission denied");
    f.recent.resolve(null);
    f.current.reject(denied);
    await flush();
    expect(r.fixes).toEqual([]);
    expect(r.onError).toHaveBeenCalledExactlyOnceWith(denied);
  });

  it("reports nothing after it was cancelled", async () => {
    const f = fakeSource();
    const r = run(f.src);
    r.cancel();
    f.recent.resolve(RECENT);
    f.current.reject(new Error("gone"));
    await flush();
    expect(r.fixes).toEqual([]);
    expect(r.onError).not.toHaveBeenCalled();
  });

  it("stops between the two fixes when cancelled", async () => {
    const f = fakeSource();
    const r = run(f.src);
    f.recent.resolve(RECENT);
    await flush();
    r.cancel();
    f.current.resolve(FRESH);
    await flush();
    expect(r.fixes).toEqual([{ pos: RECENT, fresh: false }]);
  });
});

describe("shouldRefineSearch", () => {
  const radiusM = 500;
  const fraction = 0.3;
  // Due north of RECENT by `m` meters.
  const north = (m: number): Pt => ({ lat: RECENT.lat + m / 111_195, lon: RECENT.lon });

  it("refines when the fresh fix moved past the fraction of the radius", () => {
    const fresh = north(200);
    expect(haversine(RECENT, fresh)).toBeGreaterThan(radiusM * fraction);
    expect(
      shouldRefineSearch({ searchedFrom: RECENT, radiusM, fresh, fraction, userActed: false }),
    ).toBe(true);
  });

  it("keeps the results when the fresh fix is close by", () => {
    const fresh = north(100);
    expect(haversine(RECENT, fresh)).toBeLessThan(radiusM * fraction);
    expect(
      shouldRefineSearch({ searchedFrom: RECENT, radiusM, fresh, fraction, userActed: false }),
    ).toBe(false);
  });

  it("never pulls the map away from a user who has taken it over", () => {
    expect(
      shouldRefineSearch({
        searchedFrom: RECENT,
        radiusM,
        fresh: north(5000),
        fraction,
        userActed: true,
      }),
    ).toBe(false);
  });
});
