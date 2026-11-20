import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { POST } from "@/pages/api/osm/upload";
import { POST as OPEN } from "@/pages/api/osm/changeset";
import { API_BASE, osmChangeXml, parseDiffResult } from "@/lib/osm";
import { json, text } from "../../helpers/upstream";
import { postJson, routeContext } from "../../helpers/route";

// 22:30 on 2026-10-07 in DC, already the 8th in UTC.
const NOW = new Date("2026-10-08T02:30:00Z");
const AUTH = { Authorization: "Bearer tok" };

type Node = { id: number; version: number; tags: Record<string, string>; visible?: boolean };

// A stand-in for the OSM API, answering by URL and method. Tests set the
// state it starts in and read back what was sent to it.
function fakeOsm(opts: {
  nodes?: Node[];
  changeset?: { open: boolean; changes_count: number };
  // Replies for successive uploads; a function answers from the body.
  uploads?: (Response | ((body: string) => Response))[];
  opened?: number[]; // ids for successive changeset opens
  download?: string;
}) {
  const uploads = [...(opts.uploads ?? [])];
  const opened = [...(opts.opened ?? [])];
  const sent: { url: string; method: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ url, method, body: typeof init.body === "string" ? init.body : undefined });
    const path = url.slice(API_BASE.length);
    if (method === "PUT" && path === "/api/0.6/changeset/create") {
      return text(String(opened.shift() ?? 77));
    }
    if (method === "PUT" && /\/changeset\/\d+\/close$/.test(path)) return text("");
    if (method === "GET" && /^\/api\/0\.6\/changeset\/\d+\.json$/.test(path)) {
      return json({ changeset: opts.changeset ?? { open: true, changes_count: 0 } });
    }
    if (method === "GET" && /\/changeset\/\d+\/download$/.test(path)) {
      return text(opts.download ?? "<osmChange/>");
    }
    if (method === "GET" && path.startsWith("/api/0.6/nodes.json?nodes=")) {
      const ids = path.split("=")[1].split(",").map(Number);
      const found = (opts.nodes ?? []).filter((n) => ids.includes(n.id));
      if (found.length < ids.length) return text("not found", 404);
      return json({
        elements: found.map((n) =>
          n.visible === false
            ? { id: n.id, version: n.version, visible: false }
            : { id: n.id, lat: 38.9, lon: -77, version: n.version, changeset: 30, tags: n.tags },
        ),
      });
    }
    const one = path.match(/^\/api\/0\.6\/node\/(\d+)\.json$/);
    if (method === "GET" && one) {
      const n = (opts.nodes ?? []).find((x) => x.id === Number(one[1]));
      // A deleted node is 410 Gone on its own, as OSM answers it.
      if (n?.visible === false) return text("gone", 410);
      return n
        ? json({ elements: [{ lat: 38.9, lon: -77, version: n.version, tags: n.tags }] })
        : text("not found", 404);
    }
    if (method === "POST" && /\/changeset\/\d+\/upload$/.test(path)) {
      const next = uploads.shift();
      if (!next) throw new Error("unexpected upload");
      return typeof next === "function" ? next(String(init.body)) : next;
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock: fetchMock as Mock,
    sent,
    uploadsSent: () => sent.filter((s) => s.url.endsWith("/upload")),
  };
}

// OSM's diffResult for an upload, as the real API answers it.
const diffFor = (body: string) => {
  const nodes = [...body.matchAll(/<node id="(-?\d+)"(?: version="(\d+)")?/g)];
  let nextId = 500;
  const rows = nodes.map(([, id, version]) =>
    Number(id) < 0
      ? `<node old_id="${id}" new_id="${nextId++}" new_version="1"/>`
      : `<node old_id="${id}" new_id="${id}" new_version="${Number(version) + 1}"/>`,
  );
  return text(`<diffResult version="0.6">${rows.join("")}</diffResult>`);
};

const upload = (body: Record<string, unknown>, headers: Record<string, string> = AUTH) =>
  POST(routeContext(postJson("https://waterrun.app/api/osm/upload", body, headers)));

const edit = (nodeId: number, over: Record<string, unknown> = {}) => ({
  key: `n:${nodeId}`,
  nodeId,
  action: "confirm",
  tagKey: "amenity",
  surveyDate: "2026-10-07",
  ...over,
});

const create = (tempId: number, over: Record<string, unknown> = {}) => ({
  key: `c:${tempId}`,
  tempId,
  lat: 38.91,
  lon: -77.01,
  tag: { key: "amenity", value: "drinking_water" },
  surveyDate: "2026-10-07",
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/osm/upload", () => {
  it("refuses a signed-out request", async () => {
    fakeOsm({});
    const res = await upload({ changesetId: 42, edits: [edit(1)] }, {});
    expect(res.status).toBe(401);
  });

  it("refuses an empty upload, or one that updates a point twice", async () => {
    fakeOsm({});
    expect((await upload({ changesetId: 42 })).status).toBe(400);
    const twice = await upload({ changesetId: 42, edits: [edit(1), edit(1, { key: "other" })] });
    expect(twice.status).toBe(400);
  });

  it("writes every edit and new point in one upload to the given changeset, then closes it", async () => {
    const osm = fakeOsm({
      nodes: [
        { id: 1, version: 3, tags: { amenity: "drinking_water", check_date: "2025-01-01" } },
        { id: 2, version: 7, tags: { amenity: "drinking_water" } },
      ],
      uploads: [diffFor],
    });

    const res = await upload({
      changesetId: 42,
      edits: [edit(1), edit(2, { action: "out_of_order" })],
      creates: [create(-2, { extras: { seasonal: true } })],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      changesetId: 42,
      changesetUrl: expect.stringMatching(/\/changeset\/42$/),
      unchanged: [],
    });
    expect(body.written).toEqual(
      expect.arrayContaining([
        { key: "n:1", nodeId: 1, newVersion: 4 },
        { key: "n:2", nodeId: 2, newVersion: 8 },
        { key: "c:-2", nodeId: 500, newVersion: 1 },
      ]),
    );

    const ups = osm.uploadsSent();
    expect(ups).toHaveLength(1);
    expect(ups[0].url).toBe(`${API_BASE}/api/0.6/changeset/42/upload`);
    const xml = ups[0].body!;
    // New point under its placeholder id, edits at the version read.
    expect(xml).toMatch(/<create><node id="-2" lat="38.91" lon="-77.01" changeset="42">/);
    expect(xml).toContain('<node id="1" version="3"');
    expect(xml).toContain('<node id="2" version="7"');
    expect(xml).toContain('<tag k="check_date" v="2026-10-07"/>');
    expect(xml).toContain('<tag k="disused:amenity" v="drinking_water"/>');
    expect(xml).toContain('<tag k="seasonal" v="yes"/>');
    expect(osm.sent.some((s) => s.url.endsWith("/changeset/42/close"))).toBe(true);
  });

  it("answers a resend whose first try landed from the changeset, without writing again", async () => {
    const osm = fakeOsm({
      changeset: { open: false, changes_count: 2 },
      download:
        '<osmChange version="0.6"><modify><node id="1" version="4" lat="38.9" lon="-77"/></modify>' +
        '<create><node id="900" version="1" lat="38.9100000" lon="-77.0100000"/></create></osmChange>',
    });

    const res = await upload({ changesetId: 42, edits: [edit(1)], creates: [create(-2)] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ changesetId: 42, alreadyApplied: true });
    expect(body.written).toEqual(
      expect.arrayContaining([
        { key: "n:1", nodeId: 1, newVersion: 4 },
        { key: "c:-2", nodeId: 900, newVersion: 1 },
      ]),
    );
    expect(osm.uploadsSent()).toHaveLength(0);
  });

  it("moves to a fresh changeset when the given one closed with nothing in it, and says so", async () => {
    const osm = fakeOsm({
      changeset: { open: false, changes_count: 0 },
      nodes: [{ id: 1, version: 3, tags: { amenity: "drinking_water" } }],
      opened: [88],
      uploads: [diffFor],
    });

    const res = await upload({ changesetId: 42, edits: [edit(1)] });
    expect(res.status).toBe(200);
    expect((await res.json()).changesetId).toBe(88);
    expect(osm.uploadsSent()[0].url).toBe(`${API_BASE}/api/0.6/changeset/88/upload`);
    expect(osm.uploadsSent()[0].body).toContain('changeset="88"');
  });

  it("reads again and retries after a version conflict", async () => {
    const osm = fakeOsm({
      nodes: [{ id: 1, version: 3, tags: { amenity: "drinking_water" } }],
      uploads: [text("Version mismatch: Provided 3, server had: 4 of Node 1", 409), diffFor],
    });

    const res = await upload({ changesetId: 42, edits: [edit(1)] });
    expect(res.status).toBe(200);
    expect(osm.uploadsSent()).toHaveLength(2);
  });

  it("names the points that are gone and writes nothing", async () => {
    const osm = fakeOsm({
      nodes: [
        { id: 1, version: 3, tags: { amenity: "drinking_water" } },
        { id: 2, version: 5, tags: {}, visible: false },
      ],
    });

    const res = await upload({ changesetId: 42, edits: [edit(1), edit(2), edit(3)] });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.retryable).toBe(false);
    expect(body.problems.map((p: { key: string }) => p.key).sort()).toEqual(["n:2", "n:3"]);
    expect(osm.uploadsSent()).toHaveLength(0);
  });

  it("skips edits that would change nothing", async () => {
    const osm = fakeOsm({
      nodes: [
        { id: 1, version: 3, tags: { amenity: "drinking_water", check_date: "2026-10-07" } },
        { id: 2, version: 7, tags: { amenity: "drinking_water" } },
      ],
      uploads: [diffFor],
    });

    const res = await upload({ changesetId: 42, edits: [edit(1), edit(2)] });
    const body = await res.json();
    expect(body.unchanged).toEqual(["n:1"]);
    expect(osm.uploadsSent()[0].body).not.toContain('<node id="1"');
  });

  it("uploads nothing, and closes the changeset, when no edit changes anything", async () => {
    const osm = fakeOsm({
      nodes: [{ id: 1, version: 3, tags: { amenity: "drinking_water", check_date: "2026-10-07" } }],
    });

    const res = await upload({ changesetId: 42, edits: [edit(1)] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ written: [], unchanged: ["n:1"] });
    expect(osm.uploadsSent()).toHaveLength(0);
    expect(osm.sent.some((s) => s.url.endsWith("/changeset/42/close"))).toBe(true);
  });

  it("reports OSM trouble as retryable", async () => {
    fakeOsm({
      nodes: [{ id: 1, version: 3, tags: { amenity: "drinking_water" } }],
      uploads: [text("oops", 500)],
    });
    const res = await upload({ changesetId: 42, edits: [edit(1)] });
    expect(res.status).toBe(502);
    expect((await res.json()).retryable).toBe(true);
  });
});

describe("POST /api/osm/changeset", () => {
  it("opens the changeset a run's updates go into", async () => {
    fakeOsm({ opened: [42] });
    const res = await OPEN(
      routeContext(postJson("https://waterrun.app/api/osm/changeset", {}, AUTH)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changesetId: 42 });
  });

  it("refuses a signed-out request", async () => {
    fakeOsm({});
    const res = await OPEN(routeContext(postJson("https://waterrun.app/api/osm/changeset", {})));
    expect(res.status).toBe(401);
  });
});

describe("osmChange helpers", () => {
  it("escapes tag values and parses OSM's diffResult", () => {
    const xml = osmChangeXml(5, [{ tempId: -1, lat: 1, lon: 2, tags: { note: 'a "b" <c>' } }], []);
    expect(xml).toContain('v="a &quot;b&quot; &lt;c&gt;"');
    expect(
      parseDiffResult(
        '<diffResult><node old_id="-1" new_id="12" new_version="1"/><node old_id="3" new_id="3" new_version="9"/></diffResult>',
      ),
    ).toEqual([
      { oldId: -1, newId: 12, newVersion: 1 },
      { oldId: 3, newId: 3, newVersion: 9 },
    ]);
  });
});

describe("POST /api/osm/upload — dry run", () => {
  it("reads real nodes but writes nothing to OSM", async () => {
    vi.stubEnv("OSM_DRY_RUN", "1");
    vi.resetModules();
    const { POST: dryPost } = await import("@/pages/api/osm/upload");
    const osm = fakeOsm({ nodes: [{ id: 1, version: 3, tags: { amenity: "drinking_water" } }] });

    const res = await dryPost(
      routeContext(
        postJson(
          "https://waterrun.app/api/osm/upload",
          { changesetId: 42, edits: [edit(1)], creates: [create(-2)] },
          AUTH,
        ),
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).written).toHaveLength(2);
    expect(osm.sent.every((s) => s.method === "GET" && s.url.includes("/nodes.json"))).toBe(true);
  });
});
