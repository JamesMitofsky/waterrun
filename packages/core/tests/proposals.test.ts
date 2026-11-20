import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  editKey,
  heldCount,
  useProposals,
  waitingForReview,
  type RunProposal,
} from "../src/stores/proposals";
import { archiveRoute, getArchivedRoute } from "../src/routeArchive";
import { configureTestPorts } from "./helpers/ports";

let ports: ReturnType<typeof configureTestPorts>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const stored = (routeId: string): RunProposal | undefined => {
  const raw = ports.kv.get(`water-run:proposal:${routeId}`);
  return raw ? (JSON.parse(raw) as RunProposal) : undefined;
};

// A fresh process: what's in memory is gone, only storage is left.
const relaunch = (activeRouteId?: string | null) => {
  useProposals.setState({ byRoute: {}, hydrated: false });
  useProposals.getState().hydrate(activeRouteId);
};

const record = (routeId: string, nodeId: number, action: "confirm" | "out_of_order" = "confirm") =>
  useProposals
    .getState()
    .record(routeId, { nodeId, action, tagKey: "amenity", name: `P${nodeId}` });

// The API calls a submit made, by path.
const calls = () =>
  ports.apiFetch.mock.calls.map(([path, init]) => ({
    path: path as string,
    body: init?.body ? JSON.parse(init.body as string) : undefined,
  }));

beforeEach(() => {
  ports = configureTestPorts();
  useProposals.setState({ byRoute: {}, hydrated: false });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("recording", () => {
  it("writes each update to storage the moment it's made", () => {
    const { saved } = record("r1", 1);
    expect(saved).toBe(true);
    expect(stored("r1")?.items).toEqual([
      expect.objectContaining({ kind: "edit", key: editKey(1), nodeId: 1, action: "confirm" }),
    ]);
  });

  it("keeps one update per point: a re-survey replaces the earlier one", () => {
    record("r1", 1);
    const { previous } = record("r1", 1, "out_of_order");
    expect(previous).toMatchObject({ action: "confirm" });
    expect(stored("r1")?.items).toHaveLength(1);
    expect(stored("r1")?.items[0]).toMatchObject({ action: "out_of_order" });
  });

  it("gives new points distinct negative placeholder ids", () => {
    const tag = { key: "amenity", value: "drinking_water" };
    const a = useProposals.getState().addCreate("r1", { lat: 1, lon: 2, tag });
    const b = useProposals.getState().addCreate("r1", { lat: 3, lon: 4, tag });
    expect(a.item!.tempId).toBeLessThan(-1);
    expect(b.item!.tempId).toBeLessThan(a.item!.tempId);
  });

  it("says when storage refused the write, and still holds the update", () => {
    vi.spyOn(ports.kv, "set").mockImplementation(() => {
      throw new Error("disk full");
    });
    const { saved, item } = record("r1", 1);
    expect(saved).toBe(false);
    expect(item).toBeDefined();
    expect(useProposals.getState().byRoute.r1.items).toHaveLength(1);
  });
});

describe("surviving a crash", () => {
  it("brings back a run's updates after the app dies mid-run", () => {
    record("r1", 1);
    record("r1", 2);
    relaunch("r1");
    const p = useProposals.getState().byRoute.r1;
    expect(p.state).toBe("drafting");
    expect(p.items.map((i) => i.key)).toEqual([editKey(1), editKey(2)]);
  });

  it("moves a run that ended without its review to review", () => {
    record("r1", 1);
    relaunch(null);
    expect(useProposals.getState().byRoute.r1.state).toBe("review");
    expect(stored("r1")?.state).toBe("review");
    expect(waitingForReview(useProposals.getState().byRoute)).toHaveLength(1);
  });

  it("puts a submit cut off by the app closing back to review, keeping its changeset", () => {
    record("r1", 1);
    const p = stored("r1")!;
    ports.kv.set(
      "water-run:proposal:r1",
      JSON.stringify({ ...p, state: "submitting", changesetId: 42 }),
    );
    relaunch(null);
    expect(useProposals.getState().byRoute.r1).toMatchObject({ state: "review", changesetId: 42 });
  });

  it("skips a corrupt row without losing the others", () => {
    record("r1", 1);
    record("r2", 2);
    ports.kv.set("water-run:proposal:r1", "{not json");
    relaunch(null);
    expect(Object.keys(useProposals.getState().byRoute)).toEqual(["r2"]);
  });
});

describe("ending a run", () => {
  it("sends a run with updates to review and forgets one without", () => {
    record("r1", 1);
    expect(useProposals.getState().toReview("r1")).toBe(true);
    expect(stored("r1")?.state).toBe("review");

    record("r2", 2);
    useProposals.getState().remove("r2", editKey(2));
    expect(useProposals.getState().toReview("r2")).toBe(false);
    expect(stored("r2")).toBeUndefined();
  });

  it("counts held updates until they're sent", () => {
    record("r1", 1);
    record("r1", 2);
    expect(heldCount(useProposals.getState().byRoute)).toBe(2);
  });
});

describe("review", () => {
  it("changes and removes updates, and keeps the run's archive in step", () => {
    archiveRoute({
      routeId: "r1",
      plan: {
        start: { lat: 0, lon: 0 },
        loop: true,
        tagKey: "amenity",
        tagValue: "drinking_water",
        stops: [
          { id: 1, lat: 0, lon: 0, tags: {}, status: "confirm" },
          { id: 2, lat: 0, lon: 0, tags: {}, status: "confirm" },
        ],
        vias: [],
        added: [],
        routeCoords: [],
        distanceM: 0,
        turns: [],
        index: 2,
      },
      edits: [],
    });
    record("r1", 1);
    record("r1", 2);
    useProposals.getState().toReview("r1");

    useProposals.getState().update("r1", editKey(1), { action: "out_of_order" });
    useProposals.getState().remove("r1", editKey(2));

    expect(stored("r1")?.items).toEqual([expect.objectContaining({ action: "out_of_order" })]);
    const stops = getArchivedRoute("r1")!.plan.stops;
    expect(stops.map((s) => s.status)).toEqual(["out_of_order", "skipped"]);
  });
});

describe("submit", () => {
  beforeEach(() => {
    record("r1", 1);
    useProposals.getState().addCreate("r1", {
      lat: 1,
      lon: 2,
      tag: { key: "amenity", value: "drinking_water" },
    });
    useProposals.getState().toReview("r1");
  });

  it("opens a changeset, stores it, then uploads everything to it at once", async () => {
    ports.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/osm/changeset") return json({ changesetId: 42 });
      // The changeset is on disk before the upload leaves.
      expect(stored("r1")?.changesetId).toBe(42);
      return json({
        changesetId: 42,
        changesetUrl: "https://osm.example/changeset/42",
        written: [{ key: "c:-2", nodeId: 900, newVersion: 1 }],
        unchanged: [],
      });
    });

    const out = await useProposals.getState().submit("r1");
    expect(out).toEqual({
      ok: true,
      changesetId: 42,
      changesetUrl: "https://osm.example/changeset/42",
    });
    const [open, up] = calls();
    expect(open.path).toBe("/api/osm/changeset");
    expect(up.path).toBe("/api/osm/upload");
    expect(up.body).toMatchObject({
      changesetId: 42,
      edits: [{ key: editKey(1), nodeId: 1, action: "confirm" }],
      creates: [{ key: "c:-2", tempId: -2, lat: 1, lon: 2 }],
    });
    expect(stored("r1")).toMatchObject({ state: "submitted", result: { changesetId: 42 } });
    expect(heldCount(useProposals.getState().byRoute)).toBe(0);
  });

  it("keeps the changeset after a lost reply, and the resend goes to it", async () => {
    ports.apiFetch
      .mockResolvedValueOnce(json({ changesetId: 42 }))
      .mockRejectedValueOnce(new TypeError("Network request failed"));
    const first = await useProposals.getState().submit("r1");
    expect(first).toMatchObject({ ok: false, reason: "failed" });
    expect(stored("r1")).toMatchObject({ state: "review", changesetId: 42 });
    expect(stored("r1")?.error).toBeTruthy();

    ports.apiFetch.mockResolvedValueOnce(
      json({
        changesetId: 42,
        changesetUrl: "u",
        written: [],
        unchanged: [],
        alreadyApplied: true,
      }),
    );
    const again = await useProposals.getState().submit("r1");
    expect(again.ok).toBe(true);
    // No second changeset: the resend went straight to the upload.
    expect(calls().filter((c) => c.path === "/api/osm/changeset")).toHaveLength(1);
    expect(calls().at(-1)?.body.changesetId).toBe(42);
  });

  it("attaches the server's problems to the items they're about", async () => {
    ports.apiFetch
      .mockResolvedValueOnce(json({ changesetId: 42 }))
      .mockResolvedValueOnce(
        json(
          { error: "gone", retryable: false, problems: [{ key: editKey(1), error: "Gone." }] },
          422,
        ),
      );
    const out = await useProposals.getState().submit("r1");
    expect(out).toMatchObject({ ok: false, reason: "problems" });
    expect(stored("r1")).toMatchObject({
      state: "review",
      problems: [{ key: editKey(1), error: "Gone." }],
    });

    // Removing the item clears its problem.
    useProposals.getState().remove("r1", editKey(1));
    expect(stored("r1")?.problems).toEqual([]);
  });

  it("follows the server to a fresh changeset it moved to before failing", async () => {
    ports.apiFetch
      .mockResolvedValueOnce(json({ changesetId: 42 }))
      .mockResolvedValueOnce(json({ error: "busy", retryable: true, changesetId: 88 }, 503));
    await useProposals.getState().submit("r1");
    expect(stored("r1")?.changesetId).toBe(88);
  });

  it("asks for sign-in when the server says signed out, keeping everything", async () => {
    ports.apiFetch.mockResolvedValueOnce(json({ error: "not signed in" }, 401));
    const out = await useProposals.getState().submit("r1");
    expect(out).toMatchObject({ ok: false, reason: "signed-out" });
    expect(stored("r1")).toMatchObject({ state: "review" });
    expect(stored("r1")?.items).toHaveLength(2);
  });

  it("sends once when asked twice at the same time", async () => {
    let release!: () => void;
    ports.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/osm/changeset") {
        await new Promise<void>((r) => (release = r));
        return json({ changesetId: 42 });
      }
      return json({ changesetId: 42, changesetUrl: "u", written: [], unchanged: [] });
    });
    const a = useProposals.getState().submit("r1");
    const b = await useProposals.getState().submit("r1");
    expect(b).toMatchObject({ ok: false, reason: "busy" });
    release();
    expect((await a).ok).toBe(true);
    expect(calls().filter((c) => c.path === "/api/osm/upload")).toHaveLength(1);
  });

  it("stamps the archived run with its changeset and the new points' real ids", async () => {
    archiveRoute({
      routeId: "r1",
      plan: {
        start: { lat: 0, lon: 0 },
        loop: true,
        tagKey: "amenity",
        tagValue: "drinking_water",
        stops: [],
        vias: [],
        added: [{ id: -2, lat: 1, lon: 2, tags: {} }],
        routeCoords: [],
        distanceM: 0,
        turns: [],
        index: 0,
      },
      edits: [],
    });
    ports.apiFetch.mockResolvedValueOnce(json({ changesetId: 42 })).mockResolvedValueOnce(
      json({
        changesetId: 42,
        changesetUrl: "u",
        written: [{ key: "c:-2", nodeId: 900, newVersion: 1 }],
        unchanged: [],
      }),
    );
    await useProposals.getState().submit("r1");
    const plan = getArchivedRoute("r1")!.plan;
    expect(plan.changesetId).toBe(42);
    expect(plan.added.map((f) => f.id)).toEqual([900]);
  });

  it("refuses changes once sent", async () => {
    ports.apiFetch
      .mockResolvedValueOnce(json({ changesetId: 42 }))
      .mockResolvedValueOnce(
        json({ changesetId: 42, changesetUrl: "u", written: [], unchanged: [] }),
      );
    await useProposals.getState().submit("r1");
    expect(record("r1", 5).saved).toBe(false);
    expect(useProposals.getState().remove("r1", editKey(1))).toBe(false);
  });
});
