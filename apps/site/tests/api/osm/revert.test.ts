import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { POST } from "@/pages/api/osm/revert";
import { json, text } from "../../helpers/upstream";
import { postJson, routeContext } from "../../helpers/route";

const node = (version: number, tags: Record<string, string>) =>
  json({ elements: [{ lat: 38.9, lon: -77, version, tags }] });

const revert = (body: Record<string, unknown>) =>
  POST(
    routeContext(
      postJson(
        "https://waterrun.app/api/osm/revert",
        { nodeId: 1, kind: "edit", sentVersion: 4, ...body },
        { Authorization: "Bearer tok" },
      ),
    ),
  );

let fetchMock: Mock;
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("POST /api/osm/revert", () => {
  it("restores the previous version's tags", async () => {
    fetchMock
      .mockResolvedValueOnce(node(4, { amenity: "drinking_water", check_date: "2026-10-07" }))
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("5"));

    const res = await revert({ changesetId: 42 });
    expect(await res.json()).toMatchObject({ newVersion: 5, changesetId: 42 });
  });

  it("moves to a fresh changeset when the held one belongs to another account", async () => {
    fetchMock
      .mockResolvedValueOnce(node(4, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("The user doesn't own that changeset", 409))
      .mockResolvedValueOnce(text("77"))
      .mockResolvedValueOnce(node(3, { amenity: "drinking_water" }))
      .mockResolvedValueOnce(text("5"));

    const res = await revert({ changesetId: 42 });
    expect(await res.json()).toMatchObject({ newVersion: 5, changesetId: 77 });
  });

  it("aborts when someone else has edited since", async () => {
    fetchMock.mockResolvedValueOnce(node(5, { amenity: "drinking_water" }));
    const res = await revert({ changesetId: 42 });
    expect(res.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps an OSM outage to a retryable 502", async () => {
    fetchMock.mockResolvedValueOnce(text("Service Unavailable", 503));
    const res = await revert({ changesetId: 42 });
    expect(res.status).toBe(502);
    expect((await res.json()).retryable).toBe(true);
  });
});
