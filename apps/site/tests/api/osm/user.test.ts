import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/pages/api/osm/user";
import { fakeTimeoutSignals, hangingFetch, json, text } from "../../helpers/upstream";
import { routeContext } from "../../helpers/route";

const user = () =>
  GET(
    routeContext(
      new Request("https://waterrun.app/api/osm/user", {
        headers: { Authorization: "Bearer tok" },
      }),
    ),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/osm/user", () => {
  it("trims the OSM profile to what the UI shows", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json({ user: { id: 7, display_name: "ann", changesets: { count: 3 }, roles: [] } }),
        ),
    );
    expect(await (await user()).json()).toEqual({
      id: 7,
      username: "ann",
      avatarUrl: null,
      changesetCount: 3,
      accountCreated: null,
    });
  });

  it("passes on that OSM no longer accepts the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(text("", 401)));
    expect((await user()).status).toBe(401);
  });

  it("answers a JSON 504 when OSM stalls", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());
    const p = user();
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(res.status).toBe(504);
    expect((await res.json()).error).toBeDefined();
  });
});
