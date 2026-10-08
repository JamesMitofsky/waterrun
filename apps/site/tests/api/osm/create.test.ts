import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { POST } from "@/pages/api/osm/create";
import { API_BASE } from "@/lib/osm";
import { text } from "../../helpers/upstream";
import { postJson, routeContext } from "../../helpers/route";

const CREATE_URL = `${API_BASE}/api/0.6/node/create`;

const create = (body: Record<string, unknown>) =>
  POST(
    routeContext(
      postJson(
        "https://waterrun.app/api/osm/create",
        { lat: 38.9, lon: -77, tag: { key: "amenity", value: "drinking_water" }, ...body },
        { Authorization: "Bearer tok" },
      ),
    ),
  );

const creates = (fetchMock: Mock) => fetchMock.mock.calls.filter(([url]) => url === CREATE_URL);

let fetchMock: Mock;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T02:30:00Z"));
  vi.spyOn(console, "info").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/osm/create", () => {
  it("stamps the new node with the surveyor's date", async () => {
    fetchMock.mockResolvedValueOnce(text("42")).mockResolvedValueOnce(text("123"));

    const res = await create({ surveyDate: "2026-10-07" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      nodeId: 123,
      changesetId: 42,
      tags: { amenity: "drinking_water", check_date: "2026-10-07" },
    });
    expect(creates(fetchMock)[0][1].body).toContain('<tag k="check_date" v="2026-10-07"/>');
  });

  it("uses the server's date without a survey date", async () => {
    fetchMock.mockResolvedValueOnce(text("123"));
    const res = await create({ changesetId: 42 });
    expect((await res.json()).tags.check_date).toBe("2026-10-08");
  });

  it("moves to a fresh changeset when the held one belongs to another account", async () => {
    fetchMock
      .mockResolvedValueOnce(text("The user doesn't own that changeset", 409))
      .mockResolvedValueOnce(text("77"))
      .mockResolvedValueOnce(text("123"));

    const res = await create({ changesetId: 42 });
    expect(await res.json()).toMatchObject({ nodeId: 123, changesetId: 77 });
    expect(creates(fetchMock)).toHaveLength(2);
  });

  it("maps an OSM failure to the shared statuses", async () => {
    fetchMock.mockResolvedValueOnce(text("Rate limit exceeded", 429));
    const res = await create({ changesetId: 42 });
    expect(res.status).toBe(429);
    expect((await res.json()).retryable).toBe(true);
  });

  it("answers a body that isn't JSON with a 400", async () => {
    const res = await POST(
      routeContext(
        postJson("https://waterrun.app/api/osm/create", "nope", { Authorization: "Bearer tok" }),
      ),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
