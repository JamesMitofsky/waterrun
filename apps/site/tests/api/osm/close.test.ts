import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { POST } from "@/pages/api/osm/close";
import { API_BASE, OAUTH_BASE } from "@/lib/osm";
import { text } from "../../helpers/upstream";
import { postJson, routeContext } from "../../helpers/route";

const close = (body: unknown) =>
  POST(
    routeContext(
      postJson("https://waterrun.app/api/osm/close", body, { Authorization: "Bearer tok" }),
    ),
  );

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("POST /api/osm/close", () => {
  it("closes the changeset and links to it", async () => {
    fetchMock.mockResolvedValueOnce(text(""));
    const res = await close({ changesetId: 42 });
    expect(await res.json()).toEqual({ ok: true, changesetUrl: `${OAUTH_BASE}/changeset/42` });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/0.6/changeset/42/close`);
  });

  it("has nothing to do without a changeset", async () => {
    const res = await close({});
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an id that isn't a changeset id, before it reaches the OSM URL", async () => {
    for (const changesetId of ["42/../../user", -1, 1.5]) {
      const res = await close({ changesetId });
      expect(res.status).toBe(400);
    }
    expect((await close("not json")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts a changeset OSM already closed as closed", async () => {
    fetchMock.mockResolvedValueOnce(text("The changeset 42 was closed at 2026-10-07 UTC", 409));
    const res = await close({ changesetId: 42 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changesetUrl: `${OAUTH_BASE}/changeset/42` });
  });

  it("lets a run finish whose changeset belongs to another account", async () => {
    fetchMock.mockResolvedValueOnce(text("The user doesn't own that changeset", 409));
    const res = await close({ changesetId: 42 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("reports any other failure, noting the edits are safe", async () => {
    fetchMock.mockResolvedValueOnce(text("<html>Bad gateway</html>", 502));
    const res = await close({ changesetId: 42 });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.error).toContain("edits already saved");
    expect(body.error).not.toContain("<html>");
  });
});
