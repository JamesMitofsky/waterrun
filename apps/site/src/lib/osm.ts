// OSM OAuth2 (PKCE) + edit operations: changesets and node tag updates.
// Read endpoints use .json; writes use XML per OSM API 0.6.
import crypto from "crypto";
import type { EditAction, EditExtras } from "@rosm/core/schemas";
import { APP_NAME } from "./appConfig";

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

// The same-origin path to send the user back to after sign-in, or null when
// `raw` could lead anywhere else. The check that matters is resolving it the
// way the browser will and comparing origins: the URL parser drops tabs and
// newlines and reads `\` as `/`, so "/\t/evil.com" passes any prefix test yet
// resolves to https://evil.com. Control characters and backslashes are refused
// up front as well, since no page we link back to has them in its path.
export function safeReturnPath(raw: string, origin: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (!raw.startsWith("/") || /[\u0000-\u001F\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return url.pathname + url.search + url.hash;
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
  const res = await fetch(`${OAUTH_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// Error carrying the HTTP status so callers can branch on it (e.g. 409 conflict)
// without fragile string matching on the message.
export class OsmApiError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
    readonly body: string,
  ) {
    super(`${op} ${status}: ${body}`);
    this.name = "OsmApiError";
  }
}

// A 409 whose body says the changeset "was closed" (idle timeout, prior finish,
// stale persisted id) — distinct from a 409 version conflict on the node itself.
export function isChangesetClosed(e: unknown): boolean {
  return e instanceof OsmApiError && e.status === 409 && /was closed/i.test(e.body);
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
  const res = await fetch(`${API_BASE}/api/0.6/changeset/create`, {
    method: "PUT",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
  });
  if (!res.ok) throw new OsmApiError(res.status, "open changeset", await res.text());
  return Number((await res.text()).trim());
}

export async function closeChangeset(token: string, id: number): Promise<void> {
  if (DRY_RUN) return;
  const res = await fetch(`${API_BASE}/api/0.6/changeset/${id}/close`, {
    method: "PUT",
    headers: auth(token),
  });
  // Throw so the finish flow can surface the failure. Edits already PUT are
  // safe regardless, and an unclosed changeset auto-closes server-side.
  if (!res.ok) throw new OsmApiError(res.status, "close changeset", await res.text());
}

// Web (not API) URL for a changeset, for linking the user to their edits.
export function changesetUrl(id: number): string {
  return `${OAUTH_BASE}/changeset/${id}`;
}

// ---- node ----
export type NodeData = {
  version: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
};

export async function getNode(token: string, id: number): Promise<NodeData> {
  const res = await fetch(`${API_BASE}/api/0.6/node/${id}.json`, {
    headers: auth(token),
  });
  if (!res.ok) throw new OsmApiError(res.status, "get node", await res.text());
  const json = (await res.json()) as {
    elements: { lat: number; lon: number; version: number; tags?: Record<string, string> }[];
  };
  const el = json.elements[0];
  // Deleted/redacted nodes return an empty elements array. Surface a clear error
  // instead of crashing on `el.version`.
  if (!el) throw new OsmApiError(410, "get node", `node ${id} not found (deleted or redacted)`);
  return { version: el.version, lat: el.lat, lon: el.lon, tags: el.tags ?? {} };
}

// A specific historical version of a node — the "before" state an undo restores.
export async function getNodeVersion(
  token: string,
  id: number,
  version: number,
): Promise<NodeData> {
  const res = await fetch(`${API_BASE}/api/0.6/node/${id}/${version}.json`, {
    headers: auth(token),
  });
  if (!res.ok) throw new OsmApiError(res.status, "get node version", await res.text());
  const json = (await res.json()) as {
    elements: { lat: number; lon: number; version: number; tags?: Record<string, string> }[];
  };
  const el = json.elements[0];
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

export async function putNode(
  token: string,
  id: number,
  node: NodeData,
  changesetId: number,
): Promise<number> {
  if (DRY_RUN) return node.version + 1;
  const xml = `<osm><node id="${id}" version="${node.version}" lat="${node.lat}" lon="${node.lon}" changeset="${changesetId}">${tagsXml(node.tags)}</node></osm>`;
  const res = await fetch(`${API_BASE}/api/0.6/node/${id}`, {
    method: "PUT",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
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
  const res = await fetch(`${API_BASE}/api/0.6/node/${id}`, {
    method: "DELETE",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
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
  const res = await fetch(`${API_BASE}/api/0.6/node/create`, {
    method: "PUT",
    headers: { ...auth(token), "Content-Type": "text/xml" },
    body: xml,
  });
  if (!res.ok) throw new OsmApiError(res.status, "create node", await res.text());
  return Number((await res.text()).trim()); // new node id
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

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
