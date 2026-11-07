// Foot routing via BRouter public API (free, no key). Returns street geometry + distance.
import { bearing, haversine, type Pt } from "./geo";
import { env } from "./env";
import { isTransientStatus } from "./apiResponse";
import { USER_AGENT } from "./identity";

const BROUTER_URL = env("BROUTER_URL") || "https://brouter.de/brouter";
// Foot profile available on the public brouter.de server.
const BROUTER_PROFILE = env("BROUTER_PROFILE") || "hiking-beta";

// brouter.de is one volunteer server and often overloaded. A long multi-stop
// route can legitimately take tens of seconds, so this is a ceiling against a
// hung connection rather than a budget: without it the request (and the
// planner's "routing" spinner) lasts until the platform kills the function.
const BROUTER_TIMEOUT_MS = 40_000;

// Longest upstream error text worth passing on to the user.
const ERROR_DETAIL_MAX = 200;

// A turn-by-turn maneuver, precomputed from the route geometry so the live HUD can
// just pick the next one by distance. `angle` is the heading change at the vertex
// (deg, + = right, − = left); `name` is the street/path you turn onto, present only
// when OSM tags it (most foot segments — sidewalks/footways — are unnamed).
export type Turn = {
  lat: number;
  lon: number;
  distM: number; // cumulative meters from route start to this vertex
  angle: number; // signed turn angle, [-180, 180]
  name?: string;
};

export type FootRoute = {
  // GeoJSON LineString coordinates [lon, lat]
  coords: [number, number][];
  distanceM: number;
  turns: Turn[];
};

// Minimum *net* heading change (deg) over a maneuver to call it a turn.
const TURN_MIN_DEG = 35;
// Vertices closer than this (m) are folded into one maneuver — foot geometry
// zigzags around crossings, so adjacent micro-jogs must net out, not each fire.
const TURN_MERGE_M = 15;
// Max distance (m) to associate a BRouter message's way name with a route vertex.
const NAME_SNAP_M = 20;

// BRouter `messages` rows describe each track segment, including its OSM way tags.
// Foot routing mostly rides unnamed sidewalks/footways, so names are sparse — we
// surface them only where present. Coords there are integer microdegrees.
type NamedPoint = { lat: number; lon: number; name: string };

function parseNamedPoints(messages: string[][] | undefined): NamedPoint[] {
  if (!messages || messages.length < 2) return [];
  const header = messages[0];
  const wi = header.indexOf("WayTags");
  if (wi === -1) return [];
  const out: NamedPoint[] = [];
  for (const row of messages.slice(1)) {
    const m = row[wi]?.match(/(?:^|\s)name=([^=]*?)(?:\s\w+=|$)/);
    if (!m) continue;
    out.push({
      lon: Number(row[0]) / 1e6,
      lat: Number(row[1]) / 1e6,
      name: m[1].trim(),
    });
  }
  return out;
}

// Nearest named way to a vertex, within NAME_SNAP_M; undefined if none close.
function nameNear(pt: Pt, named: NamedPoint[]): string | undefined {
  let best: string | undefined;
  let bestD = NAME_SNAP_M;
  for (const n of named) {
    const d = haversine(pt, n);
    if (d < bestD) {
      bestD = d;
      best = n.name;
    }
  }
  return best;
}

// Walk the geometry computing the heading change at every vertex, then merge
// vertices within TURN_MERGE_M into one maneuver (summing their deltas so a jog
// that nets straight doesn't register). A cluster becomes a turn when its net
// heading change is >= TURN_MIN_DEG. The name is the way you turn *onto* — the
// segment leaving the cluster's last vertex.
function extractTurns(coords: [number, number][], named: NamedPoint[]): Turn[] {
  const pt = (c: [number, number]): Pt => ({ lon: c[0], lat: c[1] });
  const turns: Turn[] = [];
  let cluster: {
    startI: number;
    lastI: number;
    startDist: number;
    lastDist: number;
    sum: number;
  } | null = null;

  const flush = () => {
    if (cluster && Math.abs(cluster.sum) >= TURN_MIN_DEG) {
      const exit = coords[Math.min(cluster.lastI + 1, coords.length - 1)];
      turns.push({
        lat: coords[cluster.startI][1],
        lon: coords[cluster.startI][0],
        distM: cluster.startDist,
        angle: (((cluster.sum % 360) + 540) % 360) - 180, // normalize sum to [-180, 180]
        name: nameNear(pt(exit), named),
      });
    }
    cluster = null;
  };

  let cum = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    cum += haversine(pt(coords[i - 1]), pt(coords[i]));
    const inB = bearing(pt(coords[i - 1]), pt(coords[i]));
    const outB = bearing(pt(coords[i]), pt(coords[i + 1]));
    const delta = ((outB - inB + 540) % 360) - 180; // [-180, 180], + = right
    if (cluster && cum - cluster.lastDist <= TURN_MERGE_M) {
      cluster.sum += delta;
      cluster.lastDist = cum;
      cluster.lastI = i;
    } else {
      flush();
      cluster = { startI: i, lastI: i, startDist: cum, lastDist: cum, sum: delta };
    }
  }
  flush();
  return turns;
}

// A routing failure we can explain to the user. `island` is set when a point
// is cut off from the foot network ("target island") and footRoute couldn't
// route around it; it carries that point's coords so the UI can highlight it
// on the map.
// `retryable` is true when the same request can succeed later (BRouter busy,
// slow or unreachable), so the UI offers a retry rather than asking the user to
// change the route.
export class RouteError extends Error {
  island?: Pt;
  retryable: boolean;
  constructor(
    message: string,
    { island, retryable = false }: { island?: Pt; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "RouteError";
    this.island = island;
    this.retryable = retryable;
  }
}

const ISLAND_MESSAGE =
  "A point on your route can't be reached on foot — it sits on an isolated path with no walkable connection to the rest of the route.";

// BRouter couldn't reach seq[index] of the request it was sent on foot: every
// path near that point is cut off from the rest of the network. footRoute
// routes around it, and only lets it out as a RouteError when it can't.
class IslandError extends Error {
  constructor(
    readonly index: number,
    readonly pt: Pt,
  ) {
    super(ISLAND_MESSAGE);
    this.name = "IslandError";
  }
}

// BRouter's routing errors are typically a line of plain text ("no track found
// at pass=0"), worth showing. A proxy in front of it answers with an HTML page,
// and a crash with a stack trace; neither may reach the user.
function errorDetail(body: string): string {
  const text = body.trim();
  if (!text || text.includes("<") || text.includes("\n")) return "";
  return text.length > ERROR_DETAIL_MAX ? `${text.slice(0, ERROR_DETAIL_MAX)}…` : text;
}

type BRouterGeoJson = {
  features?: {
    geometry?: { coordinates?: [number, number][] };
    properties?: { "track-length"?: string; messages?: string[][] };
  }[];
};

// One BRouter answer, before turns are worked out, so several can be joined
// into one route.
type Track = { coords: [number, number][]; distanceM: number; named: NamedPoint[] };

// Extra requests footRoute may spend working around cut-off points, on top of
// the first. One point routed around costs 3–5 of them.
const MAX_ISLAND_REQUESTS = 10;

// How far from a cut-off point, back towards the stop before it, to look for a
// spot the paths do reach. Only steps well short of that stop are tried: one
// close to it adds nothing to the route.
const APPROACH_STEPS_M = [60, 150];
const APPROACH_MAX_SHARE = 0.75;

// points must be in visit order; loop appends start at the end. `signal` lets
// the caller abandon the request (e.g. its own client went away).
//
// BRouter matches each waypoint to the nearest path. When that path is an
// island (cut off from the rest of the foot network), it drops it and tries the
// next nearest, but only a few times per request (5 in RoutingEngine), so a
// long route through an area full of such fragments can use the allowance up
// on other points. A point it reports as cut off is then routed around: the
// pieces on either side of it go as requests of their own, each with a fresh
// allowance; a point still cut off on its own is approached as closely as the
// paths allow, or, failing that, passed by. The route keeps every stop, so the
// runner is still led to it; only the line stops short.
export async function footRoute(
  points: Pt[],
  loop: boolean,
  signal?: AbortSignal,
): Promise<FootRoute> {
  const seq = loop ? [...points, points[0]] : points;
  let track: Track;
  try {
    try {
      track = await requestTrack(seq, signal);
    } catch (e) {
      if (!(e instanceof IslandError)) throw e;
      track = await routeAround(seq, e, { left: MAX_ISLAND_REQUESTS, cause: e, signal });
    }
  } catch (e) {
    if (e instanceof IslandError) throw new RouteError(e.message, { island: e.pt });
    throw e;
  }
  return {
    coords: track.coords,
    distanceM: track.distanceM,
    turns: extractTurns(track.coords, track.named),
  };
}

// What footRoute's recovery may still spend, and the cut-off point it reports
// if it runs out.
type Recovery = { left: number; cause: IslandError; signal?: AbortSignal };

async function attempt(seq: Pt[], rec: Recovery): Promise<Track> {
  if (rec.left <= 0) throw rec.cause;
  rec.left--;
  return requestTrack(seq, rec.signal);
}

// A request of its own for `seq`, routing around any point it reports cut off.
async function routeThrough(seq: Pt[], rec: Recovery): Promise<Track> {
  try {
    return await attempt(seq, rec);
  } catch (e) {
    if (!(e instanceof IslandError) || e === rec.cause) throw e;
    return routeAround(seq, e, rec);
  }
}

// `seq` failed because seq[k] is cut off. Route what comes before it, the leg
// into it, and what comes after it, as separate requests, then join them. Every
// piece is shorter than `seq`, so this ends.
async function routeAround(seq: Pt[], island: IslandError, rec: Recovery): Promise<Track> {
  const k = island.index;
  const from = seq[k - 1];
  const parts: Track[] = [];
  if (k >= 2) parts.push(await routeThrough(seq.slice(0, k), rec));
  // The leg on its own only helps when `seq` was more than that leg.
  const into = await legInto(from, seq[k], seq.length > 2, rec);
  if (into) parts.push(into.track);
  const rest = seq.slice(k + 1);
  if (rest.length) parts.push(await routeThrough([into ? into.end : from, ...rest], rec));
  if (!parts.length) throw island;
  return joinTracks(parts);
}

// The leg from `from` to `to`, or, when `to` is cut off, to the closest spot on
// the way there that the paths reach. Null when nothing near it is reachable;
// the route then goes on without it.
async function legInto(
  from: Pt,
  to: Pt,
  tryDirect: boolean,
  rec: Recovery,
): Promise<{ track: Track; end: Pt } | null> {
  const targets = tryDirect ? [to, ...approaches(from, to)] : approaches(from, to);
  for (const end of targets) {
    try {
      return { track: await attempt([from, end], rec), end };
    } catch (e) {
      if (!(e instanceof IslandError) || e === rec.cause) throw e;
    }
  }
  return null;
}

// Spots on the straight line from `to` back towards `from`, nearest `to` first.
function approaches(from: Pt, to: Pt): Pt[] {
  const gap = haversine(from, to);
  return APPROACH_STEPS_M.filter((d) => d <= gap * APPROACH_MAX_SHARE).map((d) => ({
    lat: to.lat + ((from.lat - to.lat) * d) / gap,
    lon: to.lon + ((from.lon - to.lon) * d) / gap,
  }));
}

// Pieces routed end to start, as one track. Where one piece ends at the very
// spot the next starts, the repeated vertex is dropped: a zero-length segment
// has no heading and would read as a turn.
function joinTracks(parts: Track[]): Track {
  const coords: [number, number][] = [];
  for (const part of parts) {
    const last = coords[coords.length - 1];
    const first = part.coords[0];
    const repeats =
      last &&
      first &&
      haversine({ lon: last[0], lat: last[1] }, { lon: first[0], lat: first[1] }) < 1;
    coords.push(...(repeats ? part.coords.slice(1) : part.coords));
  }
  return {
    coords,
    distanceM: parts.reduce((sum, p) => sum + p.distanceM, 0),
    named: parts.flatMap((p) => p.named),
  };
}

// One BRouter request through `seq`, in that order.
async function requestTrack(seq: Pt[], signal?: AbortSignal): Promise<Track> {
  const lonlats = seq.map((p) => `${p.lon},${p.lat}`).join("|");
  const url =
    `${BROUTER_URL}?lonlats=${lonlats}` +
    `&profile=${BROUTER_PROFILE}&alternativeidx=0&format=geojson`;

  // The timeout covers the body too: a server can send headers and then stall.
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, BROUTER_TIMEOUT_MS);
  const onCallerAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener("abort", onCallerAbort, { once: true });
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: ctrl.signal });
    body = await res.text();
  } catch (e) {
    if (signal?.aborted && !timedOut) throw e;
    throw new RouteError(
      timedOut
        ? "The routing server took too long to answer. Please try again in a moment."
        : "Couldn't reach the routing server. Please try again in a moment.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  if (!res.ok) {
    // "target island detected for section N": sections count from 0, and
    // section N runs from seq[N] to seq[N + 1]. BRouter's check searches back
    // from that target and gives up when it runs out of paths, so the target,
    // seq[N + 1], is the point cut off (RoutingEngine.tryFindTrack).
    const m = body.match(/target island detected for section (\d+)/i);
    if (m) {
      const idx = Math.min(Math.max(Number(m[1]) + 1, 1), seq.length - 1);
      const p = seq[idx];
      throw new IslandError(idx, { lat: p.lat, lon: p.lon });
    }
    const detail = errorDetail(body);
    const status = detail ? `BRouter ${res.status}: ${detail}` : `BRouter ${res.status}`;
    if (isTransientStatus(res.status)) {
      throw new RouteError(
        `The routing server is busy or unavailable (${status}). Please try again in a moment.`,
        { retryable: true },
      );
    }
    throw new RouteError(`Routing failed (${status}).`);
  }
  let gj: BRouterGeoJson;
  try {
    gj = JSON.parse(body) as BRouterGeoJson;
  } catch {
    // A 200 that isn't GeoJSON came from something in between, not BRouter.
    throw new RouteError("The routing server sent an unreadable reply. Please try again.", {
      retryable: true,
    });
  }
  const feat = gj.features?.[0];
  const coords = feat?.geometry?.coordinates;
  if (!coords) throw new RouteError("BRouter returned no route");
  const distanceM = Number(feat.properties?.["track-length"] ?? 0);
  return { coords, distanceM, named: parseNamedPoints(feat.properties?.messages) };
}
