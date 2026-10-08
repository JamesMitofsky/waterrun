// OSM OAuth2 (PKCE) + edit operations: changesets and node tag updates.
// Read endpoints use .json; writes use XML per OSM API 0.6.
import crypto from "crypto";
import { z } from "zod";
import type { EditAction, EditExtras } from "@rosm/core/schemas";
import { isTransientStatus } from "@rosm/core/apiResponse";
import { APP_NAME } from "./appConfig";
import {
  UpstreamNetworkError,
  UpstreamTimeoutError,
  upstreamFetch,
  upstreamSnippet,
} from "./upstream";

export const OAUTH_BASE = process.env.OSM_OAUTH_BASE || "https://www.openstreetmap.org";
export const API_BASE = process.env.OSM_API_BASE || "https://api.openstreetmap.org";
const CLIENT_ID = process.env.OSM_CLIENT_ID || "";
const CLIENT_SECRET = process.env.OSM_CLIENT_SECRET || ""; // optional (confidential client)
const SCOPE = "read_prefs write_api";

// Dry run (preview): keep real OAuth + reads, but stub every write so nothing
// reaches the OSM map. Lets the full survey flow run against live data on a
// preview deploy without persisting any edit. Reads (getNode/getNodeVersion)
// stay real. Enable with OSM_DRY_RUN=1 in the environment.
export const DRY_RUN = process.env.OSM_DRY_RUN === "1";
// Sentinels the stubbed writes return. Positive so they never trip the falsy
// `!changesetId` / nullish-reuse checks the way 0 would.
const DRY_RUN_CHANGESET = 999999999;
const DRY_RUN_NODE_ID = 999999999;
// OSM `created_by` changeset tag — the editor/app attribution shown on every
// changeset we open. Client-controlled (nothing OSM-side); we set it here. Uses
// the brand name so app edits read as "Water Run" on osm.org, not the repo slug.
const CREATED_BY = APP_NAME;

// Time limits per kind of OSM call. Reads are small and quick, so a stall is cut
// short. Writes get longer: giving up on one that was about to land only means
// the client sends it again, which is safe because an edit that is already
// applied is answered without a second write (see api/osm/edit).
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
// A create is the one write that can't be sent again safely: abandoning one that
// OSM then completes leaves the user to tap again and add a duplicate node. So it
// only gets a backstop, well past any healthy response time.
const CREATE_TIMEOUT_MS = 60_000;

// The same-origin path to send the user back to after sign-in, or null when
// `raw` could lead anywhere else. The check that matters is resolving it the
// way the browser will and comparing origins: the URL parser drops tabs and
// newlines and reads `\` as `/`, so "/\t/evil.com" passes any prefix test yet
// resolves to https://evil.com. Control characters and backslashes are refused
// up front as well, since no page we link back to has them in its path.
export function safeReturnPath(raw: string, origin: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith("/") || /[\u0000-\u001F\\]/.test(raw)) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return null;
    const path = url.pathname + url.search + url.hash;
    // Resolving collapses dot segments, which can itself produce a "//host"
    // path: "/..//evil.com" becomes "//evil.com", another site once a browser
    // reads it as a Location. So the result has to pass the same test.
    return new URL(path, origin).origin === origin ? path : null;
  } catch {
    return null;
  }
}

// ---- PKCE ----
export function makePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authUrl(redirectUri: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${OAUTH_BASE}/oauth2/authorize?${q.toString()}`;
}

export async function exchangeToken(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);
  const res = await upstreamFetch(`${OAUTH_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "token exchange", await res.text());
  const json = (await res.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw new OsmApiError(502, "token exchange", "reply carried no access token");
  }
  return json.access_token;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Error carrying the HTTP status so callers can branch on it (e.g. 409 conflict)
// without fragile string matching on the message. `body` keeps OSM's reply
// verbatim for those checks; the message carries only a short excerpt of it, so
// an HTML error page from a proxy in front of OSM never reaches the user.
export class OsmApiError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
    readonly body: string,
  ) {
    const detail = upstreamSnippet(body);
    super(detail ? `${op} ${status}: ${detail}` : `${op} ${status}`);
    this.name = "OsmApiError";
  }
}

// OSM answers 409 for unrelated reasons that only the body tells apart. These
// match the messages openstreetmap-website sends (its OSM::API*Error classes).
const is409 = (e: unknown): e is OsmApiError => e instanceof OsmApiError && e.status === 409;

// The changeset was closed: idle timeout, finished earlier, or a stale id the
// client persisted from a previous session.
export function isChangesetClosed(e: unknown): boolean {
  return is409(e) && /was closed/i.test(e.body);
}

// "The user doesn't own that changeset": the user switched OSM accounts while
// the app still held the previous account's changeset id. OSM checks ownership
// before closure, so this never turns into "was closed" by itself.
export function isChangesetNotOwned(e: unknown): boolean {
  return is409(e) && /(doesn't|does not) own/i.test(e.body);
}

// The changeset can't take this write, but a fresh one of the user's own can.
export function isChangesetUnusable(e: unknown): boolean {
  return isChangesetClosed(e) || isChangesetNotOwned(e);
}

// Someone saved the node between our read and our write ("Version mismatch:
// Provided 3, server had: 4 of Node 123"). Re-reading and re-applying fixes it;
// no other 409 is helped by trying again.
export function isVersionConflict(e: unknown): boolean {
  return is409(e) && /version mismatch/i.test(e.body);
}

export type OsmFailure = { status: number; error: string; retryable: boolean };

// How a failed OSM call is reported to our own clients: a status that says what
// kind of failure it was, which the outbox keys its retry policy off, and a
// message fit to show the user. Rejections keep OSM's own explanation, which is
// the useful part; trouble on OSM's side gets a plain sentence instead.
export function osmFailure(e: unknown): OsmFailure {
  const fail = (status: number, error: string): OsmFailure => ({
    status,
    error,
    retryable: isTransientStatus(status),
  });
  if (e instanceof UpstreamTimeoutError) {
    return fail(504, "OpenStreetMap took too long to respond. Please try again.");
  }
  if (e instanceof UpstreamNetworkError) {
    return fail(503, "Couldn't reach OpenStreetMap. Please try again.");
  }
  if (!(e instanceof OsmApiError)) {
    console.error("[osm] unexpected failure:", e);
    return fail(502, "OpenStreetMap sent a reply we couldn't read. Please try again.");
  }
  switch (e.status) {
    case 400:
    case 403:
      return fail(e.status, e.message);
    case 401:
      return fail(401, "OpenStreetMap didn't accept your sign-in. Please sign in again.");
    case 404:
    case 410:
      return fail(e.status, "This point no longer exists on OpenStreetMap.");
    // 412 is a conflict too: e.g. deleting a node that a way still uses.
    case 409:
    case 412:
      return fail(409, e.message);
    case 429:
      return fail(
        429,
        "OpenStreetMap is limiting how fast edits can be saved. Please try again in a moment.",
      );
    default:
      return fail(502, `OpenStreetMap returned an error (${e.status}). Please try again shortly.`);
  }
}

function escapeXml(s: string): string {
  return (
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // Strip XML 1.0 invalid control chars (keep tab/LF/CR) so a stray char in
      // one tag value can't make OSM reject the whole PUT.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
  );
}

// ---- changeset ----
export async function openChangeset(token: string, comment: string): Promise<number> {
  if (DRY_RUN) return DRY_RUN_CHANGESET;
  const xml = `<osm><changeset>
    <tag k="created_by" v="${escapeXml(CREATED_BY)}"/>
    <tag k="comment" v="${escapeXml(comment)}"/>
  </changeset></osm>`;
  const res = await upstreamFetch(`${API_BASE}/api/0.6/changeset/create`, {
    method: "PUT",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "open changeset", await res.text());
  return Number((await res.text()).trim());
}

export async function closeChangeset(token: string, id: number): Promise<void> {
  if (DRY_RUN) return;
  const res = await upstreamFetch(`${API_BASE}/api/0.6/changeset/${id}/close`, {
    method: "PUT",
    headers: auth(token),
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  // Throw so the finish flow can surface the failure. Edits already PUT are
  // safe regardless, and an unclosed changeset auto-closes server-side.
  if (!res.ok) throw new OsmApiError(res.status, "close changeset", await res.text());
}

// Web (not API) URL for a changeset, for linking the user to their edits.
export function changesetUrl(id: number): string {
  return `${OAUTH_BASE}/changeset/${id}`;
}

// ---- user ----
// The slice of /user/details.json the app reads.
export type OsmUserDetails = {
  id?: number;
  display_name?: string;
  img?: { href?: string };
  changesets?: { count?: number };
  account_created?: string;
};

export async function getUserDetails(token: string): Promise<OsmUserDetails> {
  const res = await upstreamFetch(`${API_BASE}/api/0.6/user/details.json`, {
    headers: auth(token),
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "get user", await res.text());
  const json = (await res.json()) as { user?: OsmUserDetails };
  return json.user ?? {};
}

// ---- node ----
export type NodeData = {
  version: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
  // The changeset that wrote this version, as read (getNode). Writes ignore it
  // and name their own.
  changeset?: number;
};

type NodeJson = {
  elements?: {
    lat: number;
    lon: number;
    version: number;
    changeset?: number;
    tags?: Record<string, string>;
  }[];
};

export async function getNode(token: string, id: number): Promise<NodeData> {
  const res = await upstreamFetch(`${API_BASE}/api/0.6/node/${id}.json`, {
    headers: auth(token),
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "get node", await res.text());
  const el = ((await res.json()) as NodeJson).elements?.[0];
  // Deleted/redacted nodes return an empty elements array. Surface a clear error
  // instead of crashing on `el.version`.
  if (!el) throw new OsmApiError(410, "get node", `node ${id} not found (deleted or redacted)`);
  return {
    version: el.version,
    lat: el.lat,
    lon: el.lon,
    tags: el.tags ?? {},
    changeset: typeof el.changeset === "number" ? el.changeset : undefined,
  };
}

// A specific historical version of a node — the "before" state an undo restores.
export async function getNodeVersion(
  token: string,
  id: number,
  version: number,
): Promise<NodeData> {
  const res = await upstreamFetch(`${API_BASE}/api/0.6/node/${id}/${version}.json`, {
    headers: auth(token),
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "get node version", await res.text());
  const el = ((await res.json()) as NodeJson).elements?.[0];
  if (!el) {
    throw new OsmApiError(410, "get node version", `node ${id} v${version} not found (redacted?)`);
  }
  return { version: el.version, lat: el.lat, lon: el.lon, tags: el.tags ?? {} };
}

function tagsXml(tags: Record<string, string>): string {
  return Object.entries(tags)
    .map(([k, v]) => `<tag k="${escapeXml(k)}" v="${escapeXml(v)}"/>`)
    .join("");
}

// Whether two tag sets are identical, whatever their key order.
export function sameTags(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && b[k] === a[k])
  );
}

export async function putNode(
  token: string,
  id: number,
  node: NodeData,
  changesetId: number,
): Promise<number> {
  if (DRY_RUN) return node.version + 1;
  const xml = `<osm><node id="${id}" version="${node.version}" lat="${node.lat}" lon="${node.lon}" changeset="${changesetId}">${tagsXml(node.tags)}</node></osm>`;
  const res = await upstreamFetch(`${API_BASE}/api/0.6/node/${id}`, {
    method: "PUT",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "put node", await res.text());
  return Number((await res.text()).trim()); // new version
}

// Delete a node (undo of a create). OSM requires the current version + position
// in the payload, hence the full NodeData. Returns the new (deleted) version.
export async function deleteNode(
  token: string,
  id: number,
  node: NodeData,
  changesetId: number,
): Promise<number> {
  if (DRY_RUN) return node.version + 1;
  const xml = `<osm><node id="${id}" version="${node.version}" lat="${node.lat}" lon="${node.lon}" changeset="${changesetId}"/></osm>`;
  const res = await upstreamFetch(`${API_BASE}/api/0.6/node/${id}`, {
    method: "DELETE",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "delete node", await res.text());
  return Number((await res.text()).trim()); // new version
}

// Create a new node. OSM assigns the id (the placeholder in the body is ignored
// for a single-element create), returned as plain text.
export async function createNode(
  token: string,
  lat: number,
  lon: number,
  tags: Record<string, string>,
  changesetId: number,
): Promise<number> {
  if (DRY_RUN) return DRY_RUN_NODE_ID;
  const xml = `<osm><node lat="${lat}" lon="${lon}" changeset="${changesetId}">${tagsXml(tags)}</node></osm>`;
  const res = await upstreamFetch(`${API_BASE}/api/0.6/node/create`, {
    method: "PUT",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
    timeoutMs: CREATE_TIMEOUT_MS,
  });
  if (!res.ok) throw new OsmApiError(res.status, "create node", await res.text());
  return Number((await res.text()).trim()); // new node id
}

// One structured log line per write that reached OSM: a trail in the platform
// logs for tracing a user's report. Unlike the old JSON-file log it has no
// reader to wait for and nothing that can fail the request after OSM said yes.
export function logOsmWrite(entry: {
  nodeId: number;
  action: string;
  changesetId?: number;
  newVersion: number;
}): void {
  console.info(JSON.stringify({ event: "osm_write", ...entry }));
}

// Pure tag transform per survey action. tagKey is the primary key (e.g. "amenity").
export function applyAction(
  tags: Record<string, string>,
  action: EditAction,
  tagKey: string,
  today: string,
  extras?: EditExtras,
): Record<string, string> {
  const next = { ...tags };
  const lifecycle = (prefix: string) => {
    if (next[tagKey] != null) {
      next[`${prefix}:${tagKey}`] = next[tagKey];
      delete next[tagKey];
    }
  };
  switch (action) {
    case "confirm":
    case "broken":
      next.check_date = today;
      break;
    case "out_of_order":
      lifecycle("disused");
      next.check_date = today;
      break;
    case "removed":
      lifecycle("abandoned");
      next.check_date = today;
      break;
  }
  // Advanced OSM facts, merged on top of the action. A public note applies to any
  // action; seasonal only makes sense where the source still exists (confirm) —
  // setting it on a disused/abandoned node would contradict itself.
  if (extras?.note) next.note = extras.note;
  if (extras?.seasonal && action === "confirm") {
    next.seasonal = "yes";
  }
  // Audience (humans / dogs / both) → drinking_water=* + dog=*, only meaningful
  // while the source still exists (confirm). amenity=drinking_water / =water_point
  // self-assert human potability, so a dogs-only source can't wear them — retag
  // as amenity=watering_place (the OSM primary for an animal drinking place). The
  // inverse restores amenity=drinking_water when a previously dogs-only point is
  // re-surveyed as human-potable, so the toggle round-trips instead of one-way
  // demoting. Other primaries (amenity=fountain, natural=spring) don't imply
  // potability, so keep them and only set the flags.
  //
  // drinking_water=yes is redundant on a primary that already asserts human
  // potability (amenity=drinking_water / water_point), so we drop it there and
  // only state potability explicitly when the primary doesn't imply it.
  // drinking_water=no is always informative (dogs-only / non-potable), so keep it.
  if (extras?.audience && action === "confirm") {
    const humanOk = extras.audience !== "dogs";
    if (!humanOk && (next.amenity === "drinking_water" || next.amenity === "water_point")) {
      next.amenity = "watering_place";
    } else if (humanOk && next.amenity === "watering_place") {
      next.amenity = "drinking_water";
    }
    const primaryAssertsPotable =
      next.amenity === "drinking_water" || next.amenity === "water_point";
    if (!humanOk) {
      next.drinking_water = "no";
    } else if (primaryAssertsPotable) {
      delete next.drinking_water;
    } else {
      next.drinking_water = "yes";
    }
    next.dog = extras.audience === "humans" ? "no" : "yes";
  }
  // Dispenser (bubbler / bottle-filler / both), only meaningful while the source
  // still exists (confirm). Follows the OSM wiki: fountain=* is the physical
  // archetype (bubbler jets up to drink from; bottle_refill jets down to fill a
  // bottle) and bottle=yes/no is an orthogonal "can you refill a bottle here".
  // "both" = a bubbler you can also fill bottles at. Only overwrite fountain=*
  // when it's unset or already a generic drinking type, so a regional value
  // (nasone, wallace, …) survives a re-survey.
  //
  // bottle=* is redundant on fountain=bottle_refill (which already implies bottle
  // refilling), so only state it on a bubbler: =yes when it also fills bottles
  // ("both"), =no when it doesn't. If a regional archetype was preserved instead
  // of bottle_refill, bottle=yes is still informative and is kept.
  if (extras?.dispenser && action === "confirm") {
    const desired = extras.dispenser === "bottle" ? "bottle_refill" : "bubbler";
    const cur = next.fountain;
    if (cur == null || cur === "bubbler" || cur === "bottle_refill") next.fountain = desired;
    if (extras.dispenser === "bubbler") {
      next.bottle = "no";
    } else if (extras.dispenser === "both") {
      next.bottle = "yes";
    } else if (next.fountain === "bottle_refill") {
      delete next.bottle;
    } else {
      next.bottle = "yes";
    }
  }
  return next;
}

// Today's date in UTC: the server's own idea of "today".
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
// How far back a client's survey date may reach: an offline queue can sync days
// after the run, but not weeks.
const SURVEY_DATE_MAX_AGE_DAYS = 30;
const IsoDate = z.iso.date();
const SurveyDateField = z.object({ surveyDate: IsoDate });

// The check_date for a write, from the raw request body: the surveyor's own
// calendar date when the client sent one (the outbox captures it on the device
// when the edit is queued), else the server's. check_date records the day
// someone stood at the point, so neither UTC (a DC evening run is already
// "tomorrow") nor the moment a queued edit finally syncs is right. A date
// outside [today − 30 days, today + 1 day] means a wrong device clock and the
// server's date wins; the extra day allows for time zones ahead of UTC.
export function surveyDateFor(body: unknown, now = new Date()): string {
  const today = todayIso(now);
  const parsed = SurveyDateField.safeParse(body);
  if (!parsed.success) return today;
  // Date-only ISO strings parse as UTC midnight, the same footing as `today`.
  const day = Date.parse(parsed.data.surveyDate);
  const base = Date.parse(today);
  if (day < base - SURVEY_DATE_MAX_AGE_DAYS * DAY_MS || day > base + DAY_MS) return today;
  return parsed.data.surveyDate;
}

// The check_date an edit leaves on a point: the survey's date, unless the point
// already carries a later one. A queued edit can reach OSM days after the
// survey, by which time someone may have checked the point again; writing the
// older date would make it look staler than its last real check. Only a full
// date that could be real counts: a partial one ("2026-10") or one past
// tomorrow, the same bound surveyDateFor uses, is replaced.
export function checkDateFor(
  existing: string | undefined,
  surveyDate: string,
  now = new Date(),
): string {
  const parsed = IsoDate.safeParse(existing);
  if (!parsed.success) return surveyDate;
  const tomorrow = todayIso(new Date(now.getTime() + DAY_MS));
  // YYYY-MM-DD strings sort by date.
  return parsed.data > surveyDate && parsed.data <= tomorrow ? parsed.data : surveyDate;
}
