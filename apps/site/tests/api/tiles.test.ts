import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_AGENT } from "@rosm/core/identity";
import { GET } from "@/pages/api/tiles";
import { OPENFREEMAP_TILEJSON } from "@/lib/basemap/tiles";
import { fakeTimeoutSignals, hangingFetch, json } from "../helpers/upstream";
import { routeContext } from "../helpers/route";

const tiles = () => GET(routeContext(new Request("https://waterrun.app/api/tiles")));

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/tiles", () => {
  it("proxies the TileJSON without its attribution, identifying the app upstream", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ tiles: ["https://t/{z}/{x}/{y}.pbf"], attribution: "x" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await tiles();
    expect(await res.json()).toEqual({ tiles: ["https://t/{z}/{x}/{y}.pbf"] });
    expect(fetchMock.mock.calls[0][0]).toBe(OPENFREEMAP_TILEJSON);
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("fails fast with a 504 when OpenFreeMap stalls", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());
    const p = tiles();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).status).toBe(504);
  });
});
