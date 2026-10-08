import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { USER_AGENT } from "@water-run/core/identity";
import {
  API_BASE,
  OAUTH_BASE,
  OsmApiError,
  applyAction,
  authUrl,
  changesetUrl,
  closeChangeset,
  createNode,
  deleteNode,
  exchangeToken,
  getNode,
  getNodeVersion,
  getUserDetails,
  isChangesetClosed,
  isChangesetNotOwned,
  isChangesetUnusable,
  isVersionConflict,
  makePkce,
  openChangeset,
  osmFailure,
  putNode,
  safeReturnPath,
  sameTags,
  surveyDateFor,
  checkDateFor,
  todayIso,
} from "@/lib/osm";
import { APP_NAME } from "@/lib/appConfig";
import { UpstreamNetworkError, UpstreamTimeoutError } from "@/lib/upstream";
import { fakeTimeoutSignals, hangingFetch } from "../helpers/upstream";

const T = "2026-01-02";

function mockFetch(...responses: Response[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fn);
  return fn;
}

const text = (body: string, status = 200) => new Response(body, { status });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("applyAction", () => {
  const base = { amenity: "drinking_water", name: "Old Fountain" };

  it("confirm stamps check_date and keeps everything else", () => {
    const next = applyAction(base, "confirm", "amenity", T);
    expect(next).toEqual({ ...base, check_date: T });
  });

  it("does not mutate the input tags", () => {
    const tags = { amenity: "drinking_water" };
    applyAction(tags, "removed", "amenity", T);
    expect(tags).toEqual({ amenity: "drinking_water" });
  });

  it("out_of_order moves the primary tag behind disused:", () => {
    const next = applyAction(base, "out_of_order", "amenity", T);
    expect(next["disused:amenity"]).toBe("drinking_water");
    expect(next.amenity).toBeUndefined();
    expect(next.check_date).toBe(T);
    expect(next.name).toBe("Old Fountain");
  });

  it("removed moves the primary tag behind abandoned:", () => {
    const next = applyAction(base, "removed", "amenity", T);
    expect(next["abandoned:amenity"]).toBe("drinking_water");
    expect(next.amenity).toBeUndefined();
    expect(next.check_date).toBe(T);
  });

  it("lifecycle actions respect a non-default primary key", () => {
    const next = applyAction({ natural: "spring" }, "out_of_order", "natural", T);
    expect(next["disused:natural"]).toBe("spring");
    expect(next.natural).toBeUndefined();
  });

  it("lifecycle actions still stamp check_date when the primary key is absent", () => {
    const next = applyAction({ name: "x" }, "removed", "amenity", T);
    expect(next).toEqual({ name: "x", check_date: T });
    expect(Object.keys(next).some((k) => k.startsWith("abandoned:"))).toBe(false);
  });

  describe("audience (confirm only)", () => {
    it("humans keeps the potable primary and drops redundant drinking_water=yes", () => {
      const next = applyAction({ amenity: "drinking_water" }, "confirm", "amenity", T, {
        audience: "humans",
      });
      expect(next).toEqual({
        amenity: "drinking_water",
        dog: "no",
        check_date: T,
      });
    });

    it("both keeps the fountain and adds a dog bowl (dog=yes, no redundant drinking_water)", () => {
      const next = applyAction({ amenity: "drinking_water" }, "confirm", "amenity", T, {
        audience: "both",
      });
      expect(next.drinking_water).toBeUndefined();
      expect(next.dog).toBe("yes");
      expect(next.amenity).toBe("drinking_water");
    });

    it("states drinking_water=yes explicitly on a primary that doesn't assert potability", () => {
      const next = applyAction({ amenity: "fountain" }, "confirm", "amenity", T, {
        audience: "humans",
      });
      expect(next.amenity).toBe("fountain");
      expect(next.drinking_water).toBe("yes");
    });

    it("dogs retags amenity=drinking_water as amenity=watering_place with explicit flags", () => {
      const next = applyAction({ amenity: "drinking_water" }, "confirm", "amenity", T, {
        audience: "dogs",
      });
      expect(next).toEqual({
        amenity: "watering_place",
        drinking_water: "no",
        dog: "yes",
        check_date: T,
      });
    });

    it("dogs retags amenity=water_point the same way", () => {
      const next = applyAction({ amenity: "water_point" }, "confirm", "amenity", T, {
        audience: "dogs",
      });
      expect(next.amenity).toBe("watering_place");
    });

    it("round-trips: re-surveying a watering_place as human-potable restores drinking_water", () => {
      const next = applyAction({ amenity: "watering_place" }, "confirm", "amenity", T, {
        audience: "both",
      });
      expect(next.amenity).toBe("drinking_water");
      expect(next.drinking_water).toBeUndefined();
      expect(next.dog).toBe("yes");
    });

    it("dogs keeps non-potability-asserting primaries (amenity=fountain)", () => {
      const next = applyAction({ amenity: "fountain" }, "confirm", "amenity", T, {
        audience: "dogs",
      });
      expect(next.amenity).toBe("fountain");
      expect(next.man_made).toBeUndefined();
      expect(next.drinking_water).toBe("no");
      expect(next.dog).toBe("yes");
    });

    it("is ignored for lifecycle actions", () => {
      const next = applyAction(base, "removed", "amenity", T, { audience: "dogs" });
      expect(next.dog).toBeUndefined();
      expect(next.drinking_water).toBeUndefined();
    });
  });

  describe("dispenser (confirm only)", () => {
    it("bubbler sets fountain=bubbler and bottle=no", () => {
      const next = applyAction({ amenity: "drinking_water" }, "confirm", "amenity", T, {
        dispenser: "bubbler",
      });
      expect(next.fountain).toBe("bubbler");
      expect(next.bottle).toBe("no");
    });

    it("both sets fountain=bubbler and bottle=yes", () => {
      const next = applyAction({ amenity: "drinking_water" }, "confirm", "amenity", T, {
        dispenser: "both",
      });
      expect(next.fountain).toBe("bubbler");
      expect(next.bottle).toBe("yes");
    });

    it("bottle sets fountain=bottle_refill and drops redundant bottle=yes", () => {
      const next = applyAction(
        { amenity: "drinking_water", fountain: "bubbler", bottle: "no" },
        "confirm",
        "amenity",
        T,
        {
          dispenser: "bottle",
        },
      );
      expect(next.fountain).toBe("bottle_refill");
      expect(next.bottle).toBeUndefined();
    });

    it("keeps bottle=yes when a regional archetype is preserved instead of bottle_refill", () => {
      const next = applyAction(
        { amenity: "drinking_water", fountain: "nasone" },
        "confirm",
        "amenity",
        T,
        {
          dispenser: "bottle",
        },
      );
      expect(next.fountain).toBe("nasone");
      expect(next.bottle).toBe("yes");
    });

    it("preserves a regional fountain archetype (nasone) instead of clobbering it", () => {
      const next = applyAction(
        { amenity: "drinking_water", fountain: "nasone" },
        "confirm",
        "amenity",
        T,
        {
          dispenser: "bubbler",
        },
      );
      expect(next.fountain).toBe("nasone");
      expect(next.bottle).toBe("no");
    });

    it("is ignored for lifecycle actions", () => {
      const next = applyAction(base, "removed", "amenity", T, { dispenser: "both" });
      expect(next.fountain).toBeUndefined();
      expect(next.bottle).toBeUndefined();
    });
  });

  describe("extras", () => {
    it("writes note for any action", () => {
      expect(applyAction(base, "removed", "amenity", T, { note: "gone" }).note).toBe("gone");
      expect(applyAction(base, "confirm", "amenity", T, { note: "ok" }).note).toBe("ok");
    });

    it("writes seasonal=yes only where the source still exists", () => {
      expect(applyAction(base, "confirm", "amenity", T, { seasonal: true }).seasonal).toBe("yes");
      expect(
        applyAction(base, "out_of_order", "amenity", T, { seasonal: true }).seasonal,
      ).toBeUndefined();
      expect(
        applyAction(base, "removed", "amenity", T, { seasonal: true }).seasonal,
      ).toBeUndefined();
    });

    it("ignores seasonal: false", () => {
      const next = applyAction(base, "confirm", "amenity", T, { seasonal: false });
      expect(next.seasonal).toBeUndefined();
    });
  });
});

describe("PKCE", () => {
  it("makePkce returns a base64url verifier and its S256 challenge", () => {
    const { verifier, challenge } = makePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("generates a fresh verifier per call", () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier);
  });

  it("authUrl points at the OAuth authorize endpoint with all PKCE params", () => {
    const url = new URL(authUrl("https://app.test/api/osm/callback", "chal123", "state456"));
    expect(url.origin + url.pathname).toBe(`${OAUTH_BASE}/oauth2/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/api/osm/callback");
    expect(url.searchParams.get("code_challenge")).toBe("chal123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state456");
    expect(url.searchParams.get("scope")).toBe("read_prefs write_api");
  });
});

describe("exchangeToken", () => {
  it("POSTs the code + verifier and returns the access token", async () => {
    const fetchMock = mockFetch(json({ access_token: "tok-1" }));
    const token = await exchangeToken("code-1", "verifier-1", "https://app.test/cb");
    expect(token).toBe("tok-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${OAUTH_BASE}/oauth2/token`);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe("https://app.test/cb");
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("throws an OsmApiError with the status on failure", async () => {
    mockFetch(text("bad grant", 400));
    await expect(exchangeToken("c", "v", "https://app.test/cb")).rejects.toMatchObject({
      name: "OsmApiError",
      status: 400,
      body: "bad grant",
    });
  });

  it("refuses a reply that carries no token", async () => {
    mockFetch(json({ token_type: "Bearer" }));
    await expect(exchangeToken("c", "v", "https://app.test/cb")).rejects.toBeInstanceOf(
      OsmApiError,
    );
  });
});

describe("changesets", () => {
  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("openChangeset PUTs XML and returns the numeric id", async () => {
    fetchMock.mockResolvedValueOnce(text(" 42\n"));
    const id = await openChangeset("tok", "Survey run");
    expect(id).toBe(42);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/0.6/changeset/create`);
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Content-Type"]).toBe("text/xml");
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
    expect(init.body).toContain(`<tag k="created_by" v="${APP_NAME}"/>`);
    expect(init.body).toContain('<tag k="comment" v="Survey run"/>');
  });

  it("openChangeset escapes XML special characters in the comment", async () => {
    fetchMock.mockResolvedValueOnce(text("1"));
    await openChangeset("tok", `a & b < c > "d" \x07bell`);
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).toContain('v="a &amp; b &lt; c &gt; &quot;d&quot; bell"');
  });

  it("openChangeset throws OsmApiError with the HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(text("nope", 401));
    const err = await openChangeset("tok", "c").catch((e) => e);
    expect(err).toBeInstanceOf(OsmApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("open changeset 401: nope");
  });

  it("keeps an HTML error page out of the message but on the error", async () => {
    const page = "<html><body><h1>502 Bad Gateway</h1></body></html>";
    fetchMock.mockResolvedValueOnce(text(page, 502));
    const err = await openChangeset("tok", "c").catch((e) => e);
    expect(err.message).toBe("open changeset 502");
    expect(err.body).toBe(page);
  });

  it("closeChangeset PUTs to the close endpoint", async () => {
    fetchMock.mockResolvedValueOnce(text(""));
    await closeChangeset("tok", 42);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/0.6/changeset/42/close`);
    expect(init.method).toBe("PUT");
  });

  it("closeChangeset surfaces failures", async () => {
    fetchMock.mockResolvedValueOnce(text("conflict", 409));
    await expect(closeChangeset("tok", 42)).rejects.toMatchObject({
      name: "OsmApiError",
      status: 409,
    });
  });

  describe("isChangesetClosed", () => {
    it("matches a 409 whose body says the changeset was closed", () => {
      const e = new OsmApiError(
        409,
        "put node",
        "The changeset 184824990 was closed at 2026-06-30 02:37:57 UTC.",
      );
      expect(isChangesetClosed(e)).toBe(true);
    });

    it("rejects a 409 version conflict on the node itself", () => {
      const e = new OsmApiError(409, "put node", "Version mismatch: Provided 3, server had: 4");
      expect(isChangesetClosed(e)).toBe(false);
    });

    it("rejects other statuses and plain errors", () => {
      expect(isChangesetClosed(new OsmApiError(404, "put node", "was closed"))).toBe(false);
      expect(isChangesetClosed(new Error("The changeset 9 was closed"))).toBe(false);
    });
  });

  describe("409 flavors", () => {
    const closed = new OsmApiError(
      409,
      "put node",
      "The changeset 9 was closed at 2026-06-30 UTC.",
    );
    const notOwned = new OsmApiError(409, "put node", "The user doesn't own that changeset");
    const mismatch = new OsmApiError(
      409,
      "put node",
      "Version mismatch: Provided 3, server had: 4 of Node 123",
    );

    it("tells a changeset of another account apart from a version conflict", () => {
      expect(isChangesetNotOwned(notOwned)).toBe(true);
      expect(isChangesetNotOwned(mismatch)).toBe(false);
      expect(isVersionConflict(notOwned)).toBe(false);
    });

    it("treats a closed or foreign changeset as unusable, and nothing else", () => {
      expect(isChangesetUnusable(closed)).toBe(true);
      expect(isChangesetUnusable(notOwned)).toBe(true);
      expect(isChangesetUnusable(mismatch)).toBe(false);
    });

    it("matches only a real version mismatch as a version conflict", () => {
      expect(isVersionConflict(mismatch)).toBe(true);
      expect(isVersionConflict(closed)).toBe(false);
      expect(isVersionConflict(new OsmApiError(412, "delete node", "Version mismatch"))).toBe(
        false,
      );
    });
  });

  it("changesetUrl links to the web (not API) host", () => {
    expect(changesetUrl(7)).toBe(`${OAUTH_BASE}/changeset/7`);
  });
});

describe("nodes", () => {
  let fetchMock: Mock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("getNode returns version, coords and tags", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        elements: [{ lat: 48.1, lon: 2.2, version: 3, tags: { amenity: "drinking_water" } }],
      }),
    );
    const node = await getNode("tok", 99);
    expect(node).toEqual({
      version: 3,
      lat: 48.1,
      lon: 2.2,
      tags: { amenity: "drinking_water" },
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/0.6/node/99.json`);
  });

  it("getNode reports the changeset that wrote the current version", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ elements: [{ lat: 1, lon: 2, version: 4, changeset: 42, tags: {} }] }),
    );
    expect((await getNode("tok", 1)).changeset).toBe(42);
  });

  it("getNode defaults missing tags to {}", async () => {
    fetchMock.mockResolvedValueOnce(json({ elements: [{ lat: 1, lon: 2, version: 1 }] }));
    expect((await getNode("tok", 1)).tags).toEqual({});
  });

  it("getNode reports deleted/redacted nodes as a 410 OsmApiError", async () => {
    fetchMock.mockResolvedValueOnce(json({ elements: [] }));
    await expect(getNode("tok", 5)).rejects.toMatchObject({
      name: "OsmApiError",
      status: 410,
    });
  });

  it("putNode PUTs the node XML and returns the new version", async () => {
    fetchMock.mockResolvedValueOnce(text("4"));
    const v = await putNode(
      "tok",
      1,
      { version: 3, lat: 48.1, lon: 2.2, tags: { amenity: "drinking_water", note: "a<b" } },
      42,
    );
    expect(v).toBe(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/0.6/node/1`);
    expect(init.body).toBe(
      '<osm><node id="1" version="3" lat="48.1" lon="2.2" changeset="42">' +
        '<tag k="amenity" v="drinking_water"/><tag k="note" v="a&lt;b"/></node></osm>',
    );
  });

  it("putNode names the app in its User-Agent", async () => {
    fetchMock.mockResolvedValueOnce(text("2"));
    await putNode("tok", 1, { version: 1, lat: 0, lon: 0, tags: {} }, 42);
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("putNode throws OsmApiError on conflict", async () => {
    fetchMock.mockResolvedValueOnce(text("version mismatch", 409));
    await expect(
      putNode("tok", 1, { version: 1, lat: 0, lon: 0, tags: {} }, 42),
    ).rejects.toMatchObject({ status: 409, op: "put node" });
  });

  it("getNodeVersion reads a specific historical version", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ elements: [{ lat: 48.1, lon: 2.2, version: 3, tags: { amenity: "fountain" } }] }),
    );
    const node = await getNodeVersion("tok", 99, 3);
    expect(node).toEqual({ version: 3, lat: 48.1, lon: 2.2, tags: { amenity: "fountain" } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/0.6/node/99/3.json`);
  });

  it("getNodeVersion reports a missing version as a 410 OsmApiError", async () => {
    fetchMock.mockResolvedValueOnce(json({ elements: [] }));
    await expect(getNodeVersion("tok", 99, 3)).rejects.toMatchObject({
      name: "OsmApiError",
      status: 410,
    });
  });

  it("deleteNode DELETEs with the current version + position and returns the new version", async () => {
    fetchMock.mockResolvedValueOnce(text("2"));
    const v = await deleteNode("tok", 42, { version: 1, lat: 48.1, lon: 2.2, tags: {} }, 9);
    expect(v).toBe(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/0.6/node/42`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(
      '<osm><node id="42" version="1" lat="48.1" lon="2.2" changeset="9"/></osm>',
    );
  });

  it("deleteNode throws OsmApiError on conflict", async () => {
    fetchMock.mockResolvedValueOnce(text("in use", 409));
    await expect(
      deleteNode("tok", 42, { version: 1, lat: 0, lon: 0, tags: {} }, 9),
    ).rejects.toMatchObject({ status: 409, op: "delete node" });
  });

  it("createNode PUTs to node/create and returns the new id", async () => {
    fetchMock.mockResolvedValueOnce(text("123456"));
    const id = await createNode("tok", 48.1, 2.2, { amenity: "drinking_water" }, 42);
    expect(id).toBe(123456);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/0.6/node/create`);
    expect(init.body).toBe(
      '<osm><node lat="48.1" lon="2.2" changeset="42">' +
        '<tag k="amenity" v="drinking_water"/></node></osm>',
    );
  });
});

describe("timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a node read that never answers", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());
    const p = getNode("tok", 1);
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("gives a write longer before giving up", async () => {
    vi.useFakeTimers();
    fakeTimeoutSignals();
    vi.stubGlobal("fetch", hangingFetch());
    const p = putNode("tok", 1, { version: 1, lat: 0, lon: 0, tags: {} }, 42);
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);
    const assertion = expect(p).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });
});

describe("getUserDetails", () => {
  it("reads the user object with the token", async () => {
    const fetchMock = mockFetch(json({ user: { id: 7, display_name: "ann" } }));
    expect(await getUserDetails("tok")).toEqual({ id: 7, display_name: "ann" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE}/api/0.6/user/details.json`);
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
  });

  it("throws OsmApiError when OSM refuses the token", async () => {
    mockFetch(text("unauthorized", 401));
    await expect(getUserDetails("tok")).rejects.toMatchObject({ status: 401 });
  });
});

describe("osmFailure", () => {
  const api = (status: number, body = "reason") => new OsmApiError(status, "put node", body);

  it.each([
    [400, 400],
    [401, 401],
    [403, 403],
    [404, 404],
    [410, 410],
    [409, 409],
    [412, 409],
    [429, 429],
    [500, 502],
    [503, 502],
    [418, 502],
  ])("maps an OSM %i to %i", (osm, ours) => {
    expect(osmFailure(api(osm)).status).toBe(ours);
  });

  it("maps a timeout to 504 and a network failure to 503, both retryable", () => {
    expect(osmFailure(new UpstreamTimeoutError("https://api.test/x", 10))).toMatchObject({
      status: 504,
      retryable: true,
    });
    expect(
      osmFailure(new UpstreamNetworkError("https://api.test/x", new TypeError("fetch failed"))),
    ).toMatchObject({ status: 503, retryable: true });
  });

  it("marks only transient failures retryable", () => {
    expect(osmFailure(api(429)).retryable).toBe(true);
    expect(osmFailure(api(500)).retryable).toBe(true);
    expect(osmFailure(api(409)).retryable).toBe(false);
    expect(osmFailure(api(401)).retryable).toBe(false);
  });

  it("keeps OSM's own reason for a rejected change", () => {
    expect(osmFailure(api(409, "Version mismatch: Provided 3")).error).toContain(
      "Version mismatch: Provided 3",
    );
  });

  it("reports anything unexpected as a 502", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(osmFailure(new SyntaxError("Unexpected token <")).status).toBe(502);
  });
});

describe("sameTags", () => {
  it("ignores key order", () => {
    expect(sameTags({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
  });

  it("notices a changed, added or removed tag", () => {
    expect(sameTags({ a: "1" }, { a: "2" })).toBe(false);
    expect(sameTags({ a: "1" }, { a: "1", b: "2" })).toBe(false);
    expect(sameTags({ a: "1", b: "2" }, { a: "1" })).toBe(false);
  });
});

describe("safeReturnPath", () => {
  const origin = "https://waterrun.app";

  it.each([
    ["//evil.com"],
    ["/\\evil.com"],
    ["/\t/evil.com"],
    ["/\n/evil.com"],
    ["/\r\n/evil.com"],
    // Dot segments that collapse into a "//host" path once resolved.
    ["/..//evil.com"],
    ["/.//evil.com"],
    ["/%2e%2e//evil.com"],
    ["/a/..//evil.com"],
    ["/..//"],
    ["https://evil.com"],
    ["javascript:alert(1)"],
    [""],
  ])("refuses %j", (raw) => {
    expect(safeReturnPath(raw, origin)).toBeNull();
  });

  it("refuses what the old prefix check let through to evil.com", () => {
    // The URL parser strips the tab, so this resolved to https://evil.com/.
    expect(new URL("/\t/evil.com", origin).origin).toBe("https://evil.com");
    expect(safeReturnPath("/\t/evil.com", origin)).toBeNull();
  });

  it("keeps a same-origin path with its query and hash", () => {
    expect(safeReturnPath("/public-drinking-fountains?x=1#a", origin)).toBe(
      "/public-drinking-fountains?x=1#a",
    );
  });

  it("refuses a path that resolving turns into another site", () => {
    // What the first check alone returned, and where a browser goes from it.
    expect(new URL("/..//evil.com", origin).pathname).toBe("//evil.com");
    expect(new URL("//evil.com", origin).origin).toBe("https://evil.com");
    expect(safeReturnPath("/..//evil.com", origin)).toBeNull();
  });

  it("returns the path as the browser would resolve it", () => {
    expect(safeReturnPath("/a/../b", origin)).toBe("/b");
  });
});

describe("todayIso", () => {
  it("returns today as YYYY-MM-DD", () => {
    expect(todayIso()).toBe(new Date().toISOString().slice(0, 10));
  });

  it("uses the UTC date", () => {
    expect(todayIso(new Date("2026-10-08T01:30:00Z"))).toBe("2026-10-08");
  });
});

describe("surveyDateFor", () => {
  const now = new Date("2026-10-08T02:30:00Z"); // 22:30 the evening before in DC

  it("takes the surveyor's own date over the server's", () => {
    expect(surveyDateFor({ surveyDate: "2026-10-07" }, now)).toBe("2026-10-07");
  });

  it("accepts a queued edit synced weeks later, up to 30 days", () => {
    expect(surveyDateFor({ surveyDate: "2026-09-08" }, now)).toBe("2026-09-08");
    expect(surveyDateFor({ surveyDate: "2026-09-07" }, now)).toBe("2026-10-08");
  });

  it("allows a date one day ahead for zones east of UTC, and no further", () => {
    expect(surveyDateFor({ surveyDate: "2026-10-09" }, now)).toBe("2026-10-09");
    expect(surveyDateFor({ surveyDate: "2026-10-10" }, now)).toBe("2026-10-08");
  });

  it("falls back to the server's date when the field is missing or malformed", () => {
    expect(surveyDateFor({}, now)).toBe("2026-10-08");
    expect(surveyDateFor(undefined, now)).toBe("2026-10-08");
    expect(surveyDateFor({ surveyDate: "2026-02-30" }, now)).toBe("2026-10-08");
    expect(surveyDateFor({ surveyDate: "2026-10-07T12:00:00Z" }, now)).toBe("2026-10-08");
    expect(surveyDateFor({ surveyDate: 20261007 }, now)).toBe("2026-10-08");
  });
});

describe("checkDateFor", () => {
  const now = new Date("2026-10-08T02:30:00Z");

  it("writes the survey's date over an older check", () => {
    expect(checkDateFor("2025-04-01", "2026-10-07", now)).toBe("2026-10-07");
  });

  it("never moves a later check back to an older survey's date", () => {
    expect(checkDateFor("2026-10-05", "2026-10-01", now)).toBe("2026-10-05");
  });

  it("keeps a later check up to tomorrow, for zones east of UTC", () => {
    expect(checkDateFor("2026-10-09", "2026-10-07", now)).toBe("2026-10-09");
  });

  it("replaces a check_date that can't be a real survey", () => {
    expect(checkDateFor("2062-10-07", "2026-10-07", now)).toBe("2026-10-07");
    expect(checkDateFor("2026-10", "2026-10-07", now)).toBe("2026-10-07");
    expect(checkDateFor("2026-02-30", "2026-10-07", now)).toBe("2026-10-07");
    expect(checkDateFor("yesterday", "2026-10-07", now)).toBe("2026-10-07");
    expect(checkDateFor(undefined, "2026-10-07", now)).toBe("2026-10-07");
  });
});
