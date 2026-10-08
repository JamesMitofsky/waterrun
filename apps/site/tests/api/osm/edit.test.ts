import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { POST } from "@/pages/api/osm/edit";
import { API_BASE } from "@/lib/osm";
import { fakeTimeoutSignals, hangingFetch, json, text } from "../../helpers/upstream";
import { postJson, routeContext } from "../../helpers/route";

const NODE_URL = `${API_BASE}/api/0.6/node/1`;
// 22:30 on 2026-10-07 in DC, already the 8th in UTC.
const NOW = new Date("2026-10-08T02:30:00Z");

// `changeset` is the one that wrote this version, as OSM reports it.
const node = (version: number, tags: Record<string, string>, changeset = 30) =>
  json({ elements: [{ lat: 38.9, lon: -77, version, changeset, tags }] });

const edit = (
  body: Record<string, unknown>,
  headers: Record<string, string> = { Authorization: "Bearer tok" },
) =>
  POST(
    routeContext(
      postJson(
        "https://waterrun.app/api/osm/edit",
        { nodeId: 1, action: "confirm", ...body },
        headers,
      ),
    ),
  );

const puts = (fetchMock: Mock) =>
  fetchMock.mock.calls.filter(([url, init]) => url === NODE_URL && init.method === "PUT");

let fetchMock: Mock;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "info").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/osm/edit — survey date", () => {
  it("stamps the date the surveyor captured, not the server's UTC date", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water", check_date: "2025-01-01" }))
      .mockResolvedValueOnce(text("42")) // open changeset
      .mockResolvedValueOnce(text("4")); // put node

    const res = await edit({ surveyDate: "2026-10-07" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ changesetId: 42, newVersion: 4, nodeId: 1 });
    expect(body.summary).toContain("check_date=2026-10-07");
    expect(puts(fetchMock)[0][1].body).toContain('<tag k="check_date" v="2026-10-07"/>');
  });

  it("falls back to the server's date for a survey date outside the window", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("4"));

    const res = await edit({ changesetId: 42, surveyDate: "2026-01-01" });
    const body = await res.json();
    expect(body.summary).toContain("check_date=2026-10-08");
    expect(puts(fetchMock)[0][1].body).toContain('<tag k="check_date" v="2026-10-08"/>');
  });
});

describe("POST /api/osm/edit — idempotent resend", () => {
  it("answers with the current version and writes nothing when the edit is already applied", async () => {
    fetchMock.mockResolvedValueOnce(
      node(4, { amenity: "drinking_water", check_date: "2026-10-07" }),
    );

    const res = await edit({ changesetId: 42, surveyDate: "2026-10-07" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      changesetId: 42,
      newVersion: 4,
      unchanged: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.info).not.toHaveBeenCalled();
  });

  it("names the changeset behind the current version rather than open one to write nothing", async () => {
    fetchMock.mockResolvedValueOnce(
      node(4, { amenity: "drinking_water", check_date: "2026-10-08" }, 42),
    );

    const res = await edit({});
    expect(await res.json()).toMatchObject({
      changesetId: 42,
      changesetUrl: expect.stringMatching(/\/changeset\/42$/),
      newVersion: 4,
      unchanged: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("answers the resend of a first edit whose reply was lost as sent, in the changeset it opened", async () => {
    // The first send opens changeset 42 and lands, but the client gives up on
    // it before the reply arrives, so it still has no changeset of its own.
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("42"))
      .mockResolvedValueOnce(text("4"));
    await edit({ surveyDate: "2026-10-07" });

    fetchMock.mockResolvedValueOnce(
      node(4, { amenity: "drinking_water", check_date: "2026-10-07" }, 42),
    );
    const res = await edit({ surveyDate: "2026-10-07" });
    expect(res.status).toBe(200);
    const body = await res.json();
    // What the outbox needs to count the edit as sent and keep the changeset.
    expect(typeof body.changesetId).toBe("number");
    expect(body).toMatchObject({ changesetId: 42, newVersion: 4, unchanged: true });
    expect(puts(fetchMock)).toHaveLength(1);
  });
});

describe("POST /api/osm/edit — check_date never goes back", () => {
  it("writes nothing for a queued confirm that a later check already covers", async () => {
    fetchMock.mockResolvedValueOnce(
      node(5, { amenity: "drinking_water", check_date: "2026-10-05" }),
    );

    const res = await edit({ changesetId: 42, surveyDate: "2026-10-01" });
    const body = await res.json();
    expect(body).toMatchObject({ newVersion: 5, unchanged: true });
    expect(body.summary).toContain("check_date=2026-10-05");
    expect(puts(fetchMock)).toHaveLength(0);
  });

  it("keeps the later check_date when a queued edit changes the status", async () => {
    fetchMock
      .mockResolvedValueOnce(node(5, { amenity: "drinking_water", check_date: "2026-10-05" }))
      .mockResolvedValueOnce(text("6"));

    const res = await edit({ action: "out_of_order", changesetId: 42, surveyDate: "2026-10-01" });
    const body = await res.json();
    expect(body.summary).toContain("check_date=2026-10-05");
    const sent = puts(fetchMock)[0][1].body;
    expect(sent).toContain('<tag k="disused:amenity" v="drinking_water"/>');
    expect(sent).toContain('<tag k="check_date" v="2026-10-05"/>');
  });
});

describe("POST /api/osm/edit — 409 handling", () => {
  it("moves to a fresh changeset when the held one belongs to another account", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("The user doesn't own that changeset", 409))
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("77")) // open changeset
      .mockResolvedValueOnce(text("4"));

    const res = await edit({ changesetId: 42 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changesetId: 77, newVersion: 4 });
    expect(puts(fetchMock).map(([, init]) => init.body)).toEqual([
      expect.stringContaining('changeset="42"'),
      expect.stringContaining('changeset="77"'),
    ]);
  });

  it("moves to a fresh changeset when the held one was closed", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("The changeset 42 was closed at 2026-10-07 21:00:00 UTC", 409))
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("77"))
      .mockResolvedValueOnce(text("4"));

    const res = await edit({ changesetId: 42 });
    expect(await res.json()).toMatchObject({ changesetId: 77, newVersion: 4 });
  });

  it("re-reads and retries after someone else saved the node first", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("Version mismatch: Provided 3, server had: 4 of Node 1", 409))
      .mockResolvedValueOnce(node(4, { amenity: "drinking_water", name: "Theirs" }))
      .mockResolvedValueOnce(text("5"));

    const res = await edit({ changesetId: 42 });
    expect(await res.json()).toMatchObject({ changesetId: 42, newVersion: 5 });
    expect(puts(fetchMock)[1][1].body).toContain('version="4"');
    expect(puts(fetchMock)[1][1].body).toContain('<tag k="name" v="Theirs"/>');
  });

  it("does not retry a conflict that trying again can't fix", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("Precondition failed: something else", 409));

    const res = await edit({ changesetId: 42 });
    expect(res.status).toBe(409);
    expect((await res.json()).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/osm/edit — failures", () => {
  it.each([
    [401, 401, false],
    [403, 403, false],
    [410, 410, false],
    [429, 429, true],
    [500, 502, true],
  ])("answers an OSM %i with %i", async (osm, ours, retryable) => {
    fetchMock.mockResolvedValueOnce(text("nope", osm));
    const res = await edit({ changesetId: 42 });
    expect(res.status).toBe(ours);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.retryable).toBe(retryable);
  });

  it("answers 503 when OSM can't be reached", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const res = await edit({ changesetId: 42 });
    expect(res.status).toBe(503);
  });

  it("answers a JSON 504 when OSM stalls", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());

    const p = edit({ changesetId: 42 });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(res.status).toBe(504);
    expect((await res.json()).retryable).toBe(true);
  });

  it("keeps an HTML error page out of the message", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("<html><body>Bad request</body></html>", 400));
    const res = await edit({ changesetId: 42 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).not.toContain("<");
  });

  it("requires a sign-in", async () => {
    const res = await edit({}, {});
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a body that isn't JSON with a 400", async () => {
    const res = await POST(
      routeContext(
        postJson("https://waterrun.app/api/osm/edit", "{nope", { Authorization: "Bearer tok" }),
      ),
    );
    expect(res.status).toBe(400);
  });

  it("logs a write that reached OSM and answers 200", async () => {
    fetchMock
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("4"));
    const res = await edit({ changesetId: 42 });
    expect(res.status).toBe(200);
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0][0])).toEqual({
      event: "osm_write",
      nodeId: 1,
      action: "confirm",
      changesetId: 42,
      newVersion: 4,
    });
  });
});
