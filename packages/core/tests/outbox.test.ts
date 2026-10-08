import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxCounts, useOutbox, UNDO_WINDOW_MS, type OutboxItem } from "../src/stores/outbox";
import { editSummary, todayLocal } from "../src/editSummary";
import { ApiTimeoutError } from "../src/apiResponse";
import { configureTestPorts } from "./helpers/ports";

// The store reads its storage + api through injected ports; tests wire spy-backed
// fakes via configureTestPorts and assert against them.
let apiFetchMock: ReturnType<typeof configureTestPorts>["apiFetch"];
let storage: ReturnType<typeof configureTestPorts>["outboxStorage"];

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const fail = (body: unknown, status = 500) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// A page from something between the app and the API (captive portal, Vercel).
const html = (status: number) =>
  new Response("<html>nope</html>", { status, headers: { "Content-Type": "text/html" } });
const accepted = () => ok({ changesetId: 1, newVersion: 2, changesetUrl: "u" });

function storedItem(over: Partial<OutboxItem>): OutboxItem {
  return {
    id: "id-x",
    nodeId: 1,
    action: "confirm",
    tagKey: "amenity",
    summary: "s",
    syncState: "pending",
    attempts: 0,
    createdAt: "2026-07-04T10:00:00.000Z",
    ...over,
  };
}

// Fresh enqueues carry a 5s undo hold that flush respects; most tests care about
// the send itself, so expire the holds up front.
const releaseHolds = () =>
  useOutbox.setState((s) => ({
    items: s.items.map((i) => ({ ...i, holdUntil: "2000-01-01T00:00:00.000Z" })),
  }));

const enqueueReady = (nodeId = 1, action: OutboxItem["action"] = "confirm") => {
  const item = useOutbox.getState().enqueue({ nodeId, action, tagKey: "amenity" });
  releaseHolds();
  return item;
};

const only = () => useOutbox.getState().items[0];
const sentBody = (call: number) => JSON.parse(apiFetchMock.mock.calls[call][1]?.body as string);

beforeEach(() => {
  const ports = configureTestPorts();
  apiFetchMock = ports.apiFetch;
  storage = ports.outboxStorage;
  useOutbox.setState({ items: [], changesetId: undefined, hydrated: false });
  // The store arms a real wake timer; fake it so none outlives its test. Only
  // the clock and timeouts: Response bodies still need the real event loop.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enqueue", () => {
  it("records a pending item with the optimistic summary and persists it", () => {
    const item = useOutbox.getState().enqueue({
      nodeId: 42,
      action: "out_of_order",
      tagKey: "amenity",
      name: "Fountain X",
      extras: { note: "leaking" },
    });

    expect(item.syncState).toBe("pending");
    expect(item.attempts).toBe(0);
    // Undo window: held back from flushing for UNDO_WINDOW_MS.
    expect(new Date(item.holdUntil as string).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(item.holdUntil as string).getTime()).toBeLessThanOrEqual(
      Date.now() + UNDO_WINDOW_MS,
    );
    expect(item.surveyDate).toBe(todayLocal());
    expect(item.summary).toBe(
      editSummary("out_of_order", "amenity", todayLocal(), { note: "leaking" }),
    );
    expect(useOutbox.getState().items).toEqual([item]);
    expect(storage.put).toHaveBeenCalledWith(item);
  });

  it("gives every item a unique id", () => {
    const a = useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    const b = useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    expect(a.id).not.toBe(b.id);
  });

  it("stamps the surveyor's local date and sends it, even when the send is days later", async () => {
    // 7:30 pm on 4 July in Los Angeles, already 5 July in UTC.
    vi.setSystemTime(new Date("2026-07-05T02:30:00.000Z"));
    vi.stubEnv("TZ", "America/Los_Angeles");
    const item = enqueueReady();
    expect(item.surveyDate).toBe("2026-07-04");
    expect(item.summary).toBe("confirmed · check_date=2026-07-04");

    vi.setSystemTime(new Date("2026-07-07T12:00:00.000Z"));
    apiFetchMock.mockImplementation(async () => accepted());
    await useOutbox.getState().flush();
    expect(sentBody(0).surveyDate).toBe("2026-07-04");
  });
});

describe("flush", () => {
  it("sends pending edits one by one and shares the changeset from the first response", async () => {
    // Fresh Response per call — a shared body can only be consumed once.
    apiFetchMock.mockImplementation(async () =>
      ok({ changesetId: 42, newVersion: 2, changesetUrl: "cs-url" }),
    );
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    useOutbox.getState().enqueue({ nodeId: 2, action: "removed", tagKey: "amenity" });
    releaseHolds();

    await useOutbox.getState().flush();

    const items = useOutbox.getState().items;
    expect(items.map((i) => i.syncState)).toEqual(["sent", "sent"]);
    expect(items.map((i) => i.changesetId)).toEqual([42, 42]);
    expect(items[0].newVersion).toBe(2);
    expect(items[0].changesetUrl).toBe("cs-url");
    expect(useOutbox.getState().changesetId).toBe(42);
    expect(storage.setMeta).toHaveBeenCalledWith("changesetId", 42);

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    const firstBody = sentBody(0);
    expect(firstBody).toMatchObject({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    expect(firstBody.changesetId).toBeUndefined();
    expect(sentBody(1).changesetId).toBe(42); // reuses the opened changeset
  });

  it("counts an edit the node already carried as sent, without claiming its version", async () => {
    // The first send of a session timed out after OSM had taken it. The resend
    // finds the node already says so, writes nothing, and has no changeset to
    // report since none was open.
    apiFetchMock.mockImplementation(async () =>
      ok({ nodeId: 1, action: "confirm", newVersion: 7, unchanged: true }),
    );
    enqueueReady();
    await useOutbox.getState().flush();

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(only().syncState).toBe("sent");
    expect(only().error).toBeUndefined();
    // The node's current version may be someone else's: nothing for undo to revert.
    expect(only().newVersion).toBeUndefined();
    expect(only().changesetId).toBeUndefined();
    expect(storage.setMeta).not.toHaveBeenCalled();
  });

  it("keeps the open changeset when an edit that wrote nothing reports none", async () => {
    useOutbox.getState().setChangeset(42);
    apiFetchMock
      .mockResolvedValueOnce(ok({ newVersion: 7, unchanged: true }))
      .mockImplementation(async () => ok({ changesetId: 42, newVersion: 3, changesetUrl: "u" }));
    enqueueReady(1);
    enqueueReady(2);
    await useOutbox.getState().flush();

    expect(useOutbox.getState().items.map((i) => i.syncState)).toEqual(["sent", "sent"]);
    expect(useOutbox.getState().changesetId).toBe(42);
    expect(sentBody(1).changesetId).toBe(42);
  });

  it("bounds every send with a request timeout", async () => {
    apiFetchMock.mockImplementation(async () => accepted());
    enqueueReady();
    await useOutbox.getState().flush();
    expect(apiFetchMock.mock.calls[0][2]).toEqual({ timeoutMs: 30_000 });
  });

  it("does nothing while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });

    await useOutbox.getState().flush();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(only().syncState).toBe("pending");
  });

  it("runs a single flush loop at a time", async () => {
    let release!: (r: Response) => void;
    apiFetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    enqueueReady();

    const first = useOutbox.getState().flush();
    const second = useOutbox.getState().flush(); // joins the running loop
    release(accepted());
    await Promise.all([first, second]);

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends an edit whose hold lapses during another send, with no further trigger", async () => {
    let releaseFirst!: (r: Response) => void;
    apiFetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (releaseFirst = resolve)))
      .mockImplementation(async () => accepted());

    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    void useOutbox.getState().flush();
    await vi.advanceTimersByTimeAsync(2_000);
    useOutbox.getState().enqueue({ nodeId: 2, action: "confirm", tagKey: "amenity" });
    void useOutbox.getState().flush();

    // t=5 s: the first hold lapses and its slow send starts; the second hold
    // lapses at t=7 s while that send is still in flight.
    await vi.advanceTimersByTimeAsync(3_100);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    releaseFirst(accepted());

    await expect(useOutbox.getState().waitUntilSettled(60_000)).resolves.toBe(true);
    expect(useOutbox.getState().items.map((i) => i.syncState)).toEqual(["sent", "sent"]);
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
  });

  it("makes a caller that joins a running loop wait for the edits it asked about", async () => {
    let releaseFirst!: (r: Response) => void;
    apiFetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (releaseFirst = resolve)))
      .mockImplementation(async () => accepted());
    enqueueReady(1);
    const first = useOutbox.getState().flush();

    enqueueReady(2);
    let joinedDone = false;
    const joined = useOutbox
      .getState()
      .flush()
      .then(() => (joinedDone = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(joinedDone).toBe(false);

    releaseFirst(accepted());
    await Promise.all([first, joined]);
    expect(useOutbox.getState().items.map((i) => i.syncState)).toEqual(["sent", "sent"]);
  });
});

describe("failure handling", () => {
  it("keeps an edit queued when the network is down and resends it after the backoff", async () => {
    apiFetchMock
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockImplementation(async () => accepted());
    enqueueReady();

    await useOutbox.getState().flush();
    let item = only();
    expect(item.syncState).toBe("pending");
    expect(item.attempts).toBe(1);
    expect(item.error).toBe("Network request failed");
    expect(item.nextAttemptAt).toBeGreaterThan(Date.now());

    await vi.advanceTimersByTimeAsync(5_100); // first backoff is at most 5 s
    item = only();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(item.syncState).toBe("sent");
    expect(item.error).toBeUndefined();
    expect(item.nextAttemptAt).toBeUndefined();
  });

  it("treats a timeout as no reply", async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiTimeoutError(30_000));
    enqueueReady();
    await useOutbox.getState().flush();
    expect(only().syncState).toBe("pending");
    expect(only().error).toBe("Request timed out after 30000ms");
  });

  it("never gives up while there is no reply at all, whatever the error type", async () => {
    // expo/fetch on device rejects with a plain Error subclass, not a TypeError.
    apiFetchMock.mockImplementation(async () => {
      throw new Error("fetch failed: The Internet connection appears to be offline.");
    });
    enqueueReady();
    for (let i = 0; i < 20; i++) await useOutbox.getState().flush({ force: true });
    expect(only().syncState).toBe("pending");
    expect(only().attempts).toBe(20);
  });

  it.each([401, 403])("keeps a %i edit queued until the user signs in", async (status) => {
    apiFetchMock.mockImplementation(async () => fail({ error: "not signed in to OSM" }, status));
    enqueueReady();
    for (let i = 0; i < 12; i++) await useOutbox.getState().flush({ force: true });
    expect(only().syncState).toBe("pending");
    expect(only().error).toBe("not signed in to OSM");

    // Signed in again. An unforced flush still waits out the backoff; the forced
    // one the app sends on sign-in goes straight out.
    apiFetchMock.mockImplementation(async () => accepted());
    await useOutbox.getState().flush();
    expect(apiFetchMock).toHaveBeenCalledTimes(12);
    await useOutbox.getState().flush({ force: true });
    expect(only().syncState).toBe("sent");
  });

  it.each([408, 429, 500, 502, 503, 504])("backs off after a %i", async (status) => {
    apiFetchMock.mockImplementation(async () => fail({ error: "OSM is busy" }, status));
    enqueueReady();
    await useOutbox.getState().flush();
    expect(only().syncState).toBe("pending");
    expect(only().serverFailures).toBe(1);
    expect(only().error).toBe("OSM is busy");
  });

  it("gives up on server errors after 8 tries", async () => {
    apiFetchMock.mockImplementation(async () => fail({ error: "OSM is down" }, 503));
    enqueueReady();
    for (let i = 0; i < 7; i++) await useOutbox.getState().flush({ force: true });
    expect(only().syncState).toBe("pending");

    await useOutbox.getState().flush({ force: true });
    expect(only().syncState).toBe("failed");
    expect(only().attempts).toBe(8);
    expect(only().error).toBe("OSM is down");
    expect(only().nextAttemptAt).toBeUndefined();
  });

  it("doesn't count time spent offline against the server-error allowance", async () => {
    apiFetchMock.mockRejectedValue(new TypeError("Network request failed"));
    enqueueReady();
    for (let i = 0; i < 10; i++) await useOutbox.getState().flush({ force: true });

    apiFetchMock.mockImplementation(async () => fail({ error: "OSM is down" }, 503));
    await useOutbox.getState().flush({ force: true });
    expect(only().syncState).toBe("pending");
    expect(only().serverFailures).toBe(1);
  });

  it.each([
    ["a 200 page that isn't ours", html(200), "Couldn't reach the server"],
    ["a platform error page", html(504), "Edit failed (HTTP 504)"],
    ["a 2xx JSON reply that isn't an edit result", ok({}), "Unexpected reply from the server"],
  ])("backs off after %s", async (_label, reply, error) => {
    apiFetchMock.mockResolvedValueOnce(reply);
    enqueueReady();
    await useOutbox.getState().flush();
    expect(only().syncState).toBe("pending");
    expect(only().serverFailures).toBe(1);
    expect(only().error).toContain(error);
  });

  it.each([400, 404, 409, 410, 422])("marks a %i failed at once", async (status) => {
    apiFetchMock.mockImplementation(async () => fail({ error: "node gone" }, status));
    enqueueReady();
    await useOutbox.getState().flush();

    expect(only().syncState).toBe("failed");
    expect(only().attempts).toBe(1);
    expect(only().error).toBe("node gone");
  });

  it("trusts the server when it says a 5xx is not worth retrying", async () => {
    apiFetchMock.mockResolvedValueOnce(fail({ error: "tag too long", retryable: false }, 502));
    enqueueReady();
    await useOutbox.getState().flush();
    expect(only().syncState).toBe("failed");
  });

  it("unwraps zod formErrors into a readable message", async () => {
    apiFetchMock.mockImplementation(async () =>
      fail({ error: { formErrors: ["bad node", "bad action"] } }, 400),
    );
    enqueueReady();

    await useOutbox.getState().flush();
    expect(only().error).toBe("bad node, bad action");
  });

  it("leaves permanently failed items alone on subsequent flushes", async () => {
    apiFetchMock.mockImplementation(async () => fail({ error: "node gone" }, 410));
    enqueueReady();
    await useOutbox.getState().flush();
    apiFetchMock.mockClear();

    await useOutbox.getState().flush({ force: true });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(only().syncState).toBe("failed");
  });
});

describe("backoff", () => {
  it("skips an edit whose backoff hasn't passed unless the flush is forced", async () => {
    apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    enqueueReady();
    await useOutbox.getState().flush();

    apiFetchMock.mockImplementation(async () => accepted());
    await useOutbox.getState().flush();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await useOutbox.getState().flush({ force: true });
    expect(apiFetchMock).toHaveBeenCalledTimes(2);
    expect(only().syncState).toBe("sent");
  });

  it("doubles from 5 s up to a 10 min ceiling", async () => {
    apiFetchMock.mockRejectedValue(new TypeError("Network request failed"));
    enqueueReady();
    const waits: number[] = [];
    for (let i = 0; i < 10; i++) {
      await useOutbox.getState().flush({ force: true });
      waits.push((only().nextAttemptAt as number) - Date.now());
    }
    // Jitter keeps each wait within 80–100% of its nominal step.
    const nominal = [5, 10, 20, 40, 80, 160, 320, 600, 600, 600].map((s) => s * 1000);
    waits.forEach((w, i) => {
      expect(w).toBeLessThanOrEqual(nominal[i]);
      expect(w).toBeGreaterThanOrEqual(nominal[i] * 0.8);
    });
  });

  it("holds every later edit behind one that is backing off, so edits keep their order", async () => {
    apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    useOutbox.getState().enqueue({ nodeId: 1, action: "out_of_order", tagKey: "amenity" });
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    useOutbox.getState().enqueue({ nodeId: 2, action: "confirm", tagKey: "amenity" });
    releaseHolds();

    await useOutbox.getState().flush();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(useOutbox.getState().items.map((i) => i.attempts)).toEqual([1, 0, 0]);

    apiFetchMock.mockImplementation(async () => accepted());
    await vi.advanceTimersByTimeAsync(5_100);
    expect(useOutbox.getState().items.map((i) => i.syncState)).toEqual(["sent", "sent", "sent"]);
    // The node's last survey is the last write OSM sees.
    expect([1, 2, 3].map((c) => sentBody(c).action)).toEqual([
      "out_of_order",
      "confirm",
      "confirm",
    ]);
  });

  it("lets later edits through once the one ahead fails for good", async () => {
    apiFetchMock
      .mockResolvedValueOnce(fail({ error: "node gone" }, 410))
      .mockImplementation(async () => accepted());
    enqueueReady(1);
    enqueueReady(2);
    await useOutbox.getState().flush();
    expect(useOutbox.getState().items.map((i) => i.syncState)).toEqual(["failed", "sent"]);
  });
});

describe("undo hold window", () => {
  it("flush skips items whose hold hasn't lapsed", async () => {
    apiFetchMock.mockImplementation(async () => accepted());
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });

    await useOutbox.getState().flush();

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(only().syncState).toBe("pending");
  });

  it("a forced flush still respects the hold", async () => {
    apiFetchMock.mockImplementation(async () => accepted());
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });

    await useOutbox.getState().flush({ force: true });
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("flush schedules a follow-up send for when the earliest hold expires", async () => {
    apiFetchMock.mockImplementation(async () => accepted());
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });

    await useOutbox.getState().flush();
    expect(apiFetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 100);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(only().syncState).toBe("sent");
  });

  it("flush sends items whose hold has already lapsed (e.g. after a reload)", async () => {
    apiFetchMock.mockImplementation(async () => accepted());
    enqueueReady();

    await useOutbox.getState().flush();
    expect(only().syncState).toBe("sent");
  });
});

describe("cancel / remove", () => {
  it("cancel drops a pending item from memory and IndexedDB", () => {
    const item = useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });

    expect(useOutbox.getState().cancel(item.id)).toBe(true);
    expect(useOutbox.getState().items).toEqual([]);
    expect(storage.delete).toHaveBeenCalledWith(item.id);
  });

  it("cancel refuses anything past pending", () => {
    const item = useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    useOutbox.setState((s) => ({
      items: s.items.map((i) => ({ ...i, syncState: "sent" as const })),
    }));

    expect(useOutbox.getState().cancel(item.id)).toBe(false);
    expect(useOutbox.getState().items).toHaveLength(1);
  });

  it("cancel refuses a pending item whose send was already tried", async () => {
    // The timed-out request may still have reached OSM.
    apiFetchMock.mockRejectedValueOnce(new ApiTimeoutError(30_000));
    const item = enqueueReady();
    await useOutbox.getState().flush();

    expect(useOutbox.getState().cancel(item.id)).toBe(false);
    expect(useOutbox.getState().items).toHaveLength(1);
  });

  it("cancel returns false for an unknown id", () => {
    expect(useOutbox.getState().cancel("nope")).toBe(false);
  });

  it("remove drops an item regardless of sync state", () => {
    const item = useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    useOutbox.setState((s) => ({
      items: s.items.map((i) => ({ ...i, syncState: "sent" as const })),
    }));

    useOutbox.getState().remove(item.id);
    expect(useOutbox.getState().items).toEqual([]);
    expect(storage.delete).toHaveBeenCalledWith(item.id);
  });

  it("an item removed mid-send is not written back when the send finishes", async () => {
    let release!: (r: Response) => void;
    apiFetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const item = enqueueReady();
    const flushing = useOutbox.getState().flush();

    await useOutbox.getState().clear();
    storage.put.mockClear();
    release(accepted());
    await flushing;

    expect(useOutbox.getState().items).toEqual([]);
    expect(storage.put).not.toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
  });
});

describe("retryAll", () => {
  it("re-arms failed items and flushes them again", async () => {
    apiFetchMock.mockResolvedValueOnce(fail({ error: "first try failed" }, 400));
    enqueueReady();
    await useOutbox.getState().flush();
    expect(only().syncState).toBe("failed");

    apiFetchMock.mockResolvedValueOnce(ok({ changesetId: 8, newVersion: 3, changesetUrl: "u" }));
    await useOutbox.getState().retryAll();

    const item = only();
    expect(item.syncState).toBe("sent");
    expect(item.attempts).toBe(2);
    expect(item.error).toBeUndefined();
    expect(item.holdUntil).toBeUndefined(); // explicit resend: undo hold dropped
  });

  it("gives an edit that ran out of server retries a fresh allowance", async () => {
    apiFetchMock.mockImplementation(async () => fail({ error: "OSM is down" }, 503));
    enqueueReady();
    for (let i = 0; i < 8; i++) await useOutbox.getState().flush({ force: true });
    expect(only().syncState).toBe("failed");

    await useOutbox.getState().retryAll();
    expect(only().syncState).toBe("pending");
    expect(only().serverFailures).toBe(1);
  });
});

describe("waitUntilSettled", () => {
  it("resolves true at once when nothing is pending or sending", async () => {
    useOutbox.setState({
      items: [
        storedItem({ id: "a", syncState: "sent" }),
        storedItem({ id: "b", syncState: "failed" }),
      ],
    });
    await expect(useOutbox.getState().waitUntilSettled(1_000)).resolves.toBe(true);
  });

  it("resolves true once the queue drains", async () => {
    apiFetchMock.mockImplementation(async () => accepted());
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    void useOutbox.getState().flush({ force: true });

    const settled = useOutbox.getState().waitUntilSettled(30_000);
    await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 100);
    await expect(settled).resolves.toBe(true);
  });

  it("resolves false when edits are still waiting at the deadline", async () => {
    apiFetchMock.mockRejectedValue(new TypeError("Network request failed"));
    enqueueReady();
    await useOutbox.getState().flush();

    const settled = useOutbox.getState().waitUntilSettled(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(settled).resolves.toBe(false);
  });
});

describe("pruneSent", () => {
  it("drops only sent edits, from memory and storage", async () => {
    useOutbox.setState({
      items: [
        storedItem({ id: "sent-1", syncState: "sent" }),
        storedItem({ id: "pending", syncState: "pending" }),
        storedItem({ id: "sending", syncState: "sending" }),
        storedItem({ id: "failed", syncState: "failed" }),
        storedItem({ id: "sent-2", syncState: "sent" }),
      ],
    });

    await useOutbox.getState().pruneSent();

    expect(useOutbox.getState().items.map((i) => i.id)).toEqual(["pending", "sending", "failed"]);
    expect(storage.delete.mock.calls.map(([id]) => id)).toEqual(["sent-1", "sent-2"]);
    expect(storage.clear).not.toHaveBeenCalled();
  });
});

describe("hydrate", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
  });

  it("loads persisted items sorted by creation, resetting interrupted sends", async () => {
    storage.getAll.mockResolvedValueOnce([
      storedItem({ id: "b", createdAt: "2026-07-04T11:00:00.000Z", syncState: "sending" }),
      storedItem({ id: "a", createdAt: "2026-07-04T10:00:00.000Z", syncState: "sent" }),
      storedItem({
        id: "c",
        createdAt: "2026-07-04T12:00:00.000Z",
        syncState: "failed",
        serverFailures: 0,
      }),
    ]);
    storage.getMeta.mockResolvedValueOnce(77);

    await useOutbox.getState().hydrate();

    const s = useOutbox.getState();
    expect(s.hydrated).toBe(true);
    expect(s.changesetId).toBe(77);
    expect(s.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(s.items.map((i) => i.syncState)).toEqual(["sent", "pending", "failed"]);
    expect(storage.put).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b", syncState: "pending" }),
    );
  });

  it("drops sent edits older than a week, keeping anything unsent", async () => {
    storage.getAll.mockResolvedValueOnce([
      storedItem({ id: "old-sent", createdAt: "2026-06-20T10:00:00.000Z", syncState: "sent" }),
      storedItem({
        id: "old-pending",
        createdAt: "2026-06-20T11:00:00.000Z",
        syncState: "pending",
      }),
      storedItem({
        id: "old-failed",
        createdAt: "2026-06-20T12:00:00.000Z",
        syncState: "failed",
        serverFailures: 0,
      }),
      storedItem({ id: "new-sent", createdAt: "2026-07-01T10:00:00.000Z", syncState: "sent" }),
    ]);

    await useOutbox.getState().hydrate();

    expect(useOutbox.getState().items.map((i) => i.id)).toEqual([
      "old-pending",
      "old-failed",
      "new-sent",
    ]);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith("old-sent");
  });

  it("still marks the outbox hydrated when storage can't be read", async () => {
    storage.getAll.mockRejectedValueOnce(new Error("disk I/O error"));
    const item = useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });

    await expect(useOutbox.getState().hydrate()).resolves.toBeUndefined();
    expect(useOutbox.getState().hydrated).toBe(true);
    expect(useOutbox.getState().items).toEqual([item]);
  });

  it("keeps the queue when only the changeset id can't be read", async () => {
    storage.getAll.mockResolvedValueOnce([storedItem({ id: "a" })]);
    storage.getMeta.mockRejectedValueOnce(new SyntaxError("JSON Parse error: Unexpected EOF"));

    await useOutbox.getState().hydrate();
    expect(useOutbox.getState().hydrated).toBe(true);
    expect(useOutbox.getState().items.map((i) => i.id)).toEqual(["a"]);
    expect(useOutbox.getState().changesetId).toBeUndefined();
  });

  it("re-arms a recent edit the old outbox gave up on, with the day it was surveyed", async () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // Rows from before resends were classified: no serverFailures, no surveyDate.
    storage.getAll.mockResolvedValueOnce([
      storedItem({
        id: "offline",
        syncState: "failed",
        attempts: 1,
        error: "Network request failed",
        createdAt: "2026-07-04T02:30:00.000Z", // 7:30 pm on 3 July in Los Angeles
      }),
      storedItem({
        id: "too-old",
        syncState: "failed",
        attempts: 1,
        createdAt: "2026-05-01T19:00:00.000Z",
      }),
      // Refused under the new rules: stays failed.
      storedItem({
        id: "refused",
        syncState: "failed",
        attempts: 1,
        serverFailures: 0,
        surveyDate: "2026-07-04",
        error: "node gone",
        createdAt: "2026-07-04T20:00:00.000Z",
      }),
    ]);

    await useOutbox.getState().hydrate();
    const row = (id: string) => useOutbox.getState().items.find((i) => i.id === id);
    const [offline, tooOld, refused] = ["offline", "too-old", "refused"].map(row);
    expect(offline).toMatchObject({
      syncState: "pending",
      serverFailures: 0,
      surveyDate: "2026-07-03",
    });
    expect(offline?.error).toBeUndefined();
    expect(storage.put).toHaveBeenCalledWith(offline);
    // Too old for the server to take its survey date, so not resent behind the user's back.
    expect(tooOld).toMatchObject({ syncState: "failed", surveyDate: "2026-05-01" });
    expect(refused).toMatchObject({ syncState: "failed", error: "node gone" });
    expect(storage.put).not.toHaveBeenCalledWith(expect.objectContaining({ id: "refused" }));

    apiFetchMock.mockImplementation(async () => accepted());
    await useOutbox.getState().flush({ force: true });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody(0).surveyDate).toBe("2026-07-03");
  });

  it("tolerates a row without a creation time", async () => {
    const broken = {
      ...storedItem({ id: "broken" }),
      createdAt: undefined,
    } as unknown as OutboxItem;
    storage.getAll.mockResolvedValueOnce([storedItem({ id: "ok" }), broken]);

    await useOutbox.getState().hydrate();
    expect(useOutbox.getState().hydrated).toBe(true);
    expect(
      useOutbox
        .getState()
        .items.map((i) => i.id)
        .sort(),
    ).toEqual(["broken", "ok"]);
  });

  it("keeps an edit recorded while the queue was loading", async () => {
    let finishLoad!: (rows: OutboxItem[]) => void;
    storage.getAll.mockImplementationOnce(() => new Promise((resolve) => (finishLoad = resolve)));
    const loading = useOutbox.getState().hydrate();
    const fresh = useOutbox.getState().enqueue({ nodeId: 9, action: "confirm", tagKey: "amenity" });

    finishLoad([storedItem({ id: "stored", createdAt: "2026-07-04T10:00:00.000Z" })]);
    await loading;
    expect(useOutbox.getState().items.map((i) => i.id)).toEqual(["stored", fresh.id]);
  });

  it("only hydrates once", async () => {
    await useOutbox.getState().hydrate();
    await useOutbox.getState().hydrate();
    expect(storage.getAll).toHaveBeenCalledTimes(1);
  });
});

describe("clear", () => {
  it("wipes items, changeset and the persisted queue, unsent edits included", async () => {
    useOutbox.getState().enqueue({ nodeId: 1, action: "confirm", tagKey: "amenity" });
    useOutbox.getState().setChangeset(9);

    await useOutbox.getState().clear();

    expect(useOutbox.getState().items).toEqual([]);
    expect(useOutbox.getState().changesetId).toBeUndefined();
    expect(storage.clear).toHaveBeenCalled();
    expect(storage.setMeta).toHaveBeenLastCalledWith("changesetId", undefined);
  });
});

describe("outboxCounts", () => {
  it("derives review counts, treating everything unconfirmed as unsent", () => {
    const items = [
      storedItem({ id: "1", syncState: "sent" }),
      storedItem({ id: "2", syncState: "sent" }),
      storedItem({ id: "3", syncState: "pending" }),
      storedItem({ id: "4", syncState: "sending" }),
      storedItem({ id: "5", syncState: "failed" }),
    ];
    expect(outboxCounts(items)).toEqual({
      sent: 2,
      pending: 1,
      sending: 1,
      failed: 1,
      unsent: 3,
      total: 5,
    });
  });

  it("handles an empty outbox", () => {
    expect(outboxCounts([])).toEqual({
      sent: 0,
      pending: 0,
      sending: 0,
      failed: 0,
      unsent: 0,
      total: 0,
    });
  });
});
