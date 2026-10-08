import type { Pt } from "./geo";
import type { Turn } from "./brouter";
import type { Fountain } from "./schemas";
import type { KvPort } from "./ports";
import type { RunStop } from "./stores/run";
import type { OutboxItem } from "./stores/outbox";
import { corePorts } from "./configure";

// Durable on-device record of every route the surveyor runs. Replaces the old
// "Export JSON backup" download: instead of a one-off file the user has to
// remember to save, each route — plus every node change made along the way — is
// written to the device's key/value store automatically and kept for good.
// Survives reloads, OSM submission failures, and moving between runs.
//
// Keyed by routeId so a single run is updated in place (not duplicated) as it
// progresses and across reloads. The newest snapshot wins.
//
// Layout: one key per route plus a small index of summaries. The store is
// synchronous (it runs on the JS thread on mobile) and every survey tap
// archives, so a write must cost one run, not the whole history: the original
// single blob was re-parsed and rewritten in full on every tap and grew with
// each run.

const INDEX_KEY = "run-for-maps:archive:index";
const routeKey = (routeId: string) => `run-for-maps:archive:route:${routeId}`;
// The original single-blob archive, migrated into the layout above on first use.
const LEGACY_KEY = "run-for-maps:archive";

export type ArchivedRoute = {
  routeId: string;
  startedAt: string; // ISO — first time this route was archived
  updatedAt: string; // ISO — last snapshot
  plan: {
    start: Pt;
    loop: boolean;
    tagKey: string;
    tagValue: string;
    stops: RunStop[]; // carries each node's recorded status
    vias: Pt[];
    // Nearby non-target fountains shown dimmed during the run. Dropped once the
    // run is finished: it's the largest part of a snapshot (every point in the
    // search radius, with tags) and nothing after the run reads it.
    pool?: Fountain[];
    added: Fountain[]; // nodes created on the fly
    routeCoords: [number, number][];
    distanceM: number;
    turns: Turn[];
    index: number;
    changesetId?: number;
  };
  edits: OutboxItem[]; // full outbox: per-edit changeset + sync state
};

export type RouteSnapshot = Pick<ArchivedRoute, "routeId" | "plan" | "edits">;

// What a list of past runs needs, without loading each run.
export type ArchivedRouteSummary = {
  routeId: string;
  startedAt: string;
  updatedAt: string;
  distanceM: number;
  stopCount: number;
  surveyedCount: number; // stops given a survey result (not pending or skipped)
};

function summarize(r: ArchivedRoute): ArchivedRouteSummary {
  return {
    routeId: r.routeId,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
    distanceM: r.plan.distanceM,
    stopCount: r.plan.stops.length,
    surveyedCount: r.plan.stops.filter((s) => s.status !== "pending" && s.status !== "skipped")
      .length,
  };
}

const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) =>
  b.updatedAt.localeCompare(a.updatedAt);

const isFinished = (plan: ArchivedRoute["plan"]) => plan.index >= plan.stops.length;

// A finished run keeps everything but its pool (see ArchivedRoute.plan.pool).
function forStorage(r: ArchivedRoute): ArchivedRoute {
  if (!isFinished(r.plan) || r.plan.pool === undefined) return r;
  const { pool: _pool, ...plan } = r.plan;
  return { ...r, plan };
}

// The kv port, or null where core isn't configured (SSR): archiving is
// best-effort and must never throw into a run.
function store(): KvPort | null {
  try {
    return corePorts().kv;
  } catch {
    return null;
  }
}

function parse(raw: string | null): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRoute(v: unknown): v is ArchivedRoute {
  const r = v as ArchivedRoute | null;
  return (
    !!r &&
    typeof r.routeId === "string" &&
    r.routeId !== "" &&
    typeof r.updatedAt === "string" &&
    !!r.plan &&
    Array.isArray(r.plan.stops)
  );
}

function isSummary(v: unknown): v is ArchivedRouteSummary {
  const s = v as ArchivedRouteSummary | null;
  return !!s && typeof s.routeId === "string" && typeof s.updatedAt === "string";
}

function readIndex(kv: KvPort): ArchivedRouteSummary[] {
  const list = parse(kv.get(INDEX_KEY));
  return Array.isArray(list) ? list.filter(isSummary) : [];
}

function readRoute(kv: KvPort, routeId: string): ArchivedRoute | undefined {
  const r = parse(kv.get(routeKey(routeId)));
  // A corrupt or half-written blob is skipped, not thrown: one bad run must not
  // take the rest of the history (or the run screen) down with it.
  return isRoute(r) && r.routeId === routeId ? r : undefined;
}

// Add or replace one route's summary in the index; returns the updated index.
function indexRoute(
  kv: KvPort,
  stored: ArchivedRoute,
  index: ArchivedRouteSummary[],
): ArchivedRouteSummary[] {
  const next = [...index.filter((s) => s.routeId !== stored.routeId), summarize(stored)];
  kv.set(INDEX_KEY, JSON.stringify(next));
  return next;
}

// Write one route, then its summary; returns the updated index. The route goes
// first so the index never lists a run that isn't stored. A failure between the
// two leaves the run stored but unlisted until something lists it again: the
// run's next archive, or the migration on the next launch.
function writeRoute(
  kv: KvPort,
  r: ArchivedRoute,
  index: ArchivedRouteSummary[],
): ArchivedRouteSummary[] {
  const stored = forStorage(r);
  kv.set(routeKey(r.routeId), JSON.stringify(stored));
  return indexRoute(kv, stored, index);
}

// Ports already checked for the legacy blob this session (one per configured
// store, so a test's fresh store is checked again).
const migrated = new WeakSet<KvPort>();

// Move the original single-blob archive into the per-route layout, once.
// History must survive this, so it is careful about what it overwrites and
// when it lets go of the old blob:
// - A route that already reads back from the new layout is never overwritten:
//   if an earlier attempt was interrupted after writing it, the run may have
//   moved on since. If that attempt stopped before listing it, it is listed
//   from what was stored.
// - The legacy key is removed only once every route it held reads back from
//   the new keys and is in the index. An entry that can't be migrated (not a
//   route at all) keeps the legacy key in place, so nothing is ever thrown
//   away unread.
function migrateLegacy(kv: KvPort) {
  if (migrated.has(kv)) return;
  migrated.add(kv);
  try {
    const legacy = parse(kv.get(LEGACY_KEY));
    if (!Array.isArray(legacy)) return; // absent, or unreadable: leave it be
    const routes = legacy.filter(isRoute);
    let index = readIndex(kv);
    // Upserts kept one entry per route in the old blob; if not, the newest wins.
    for (const r of [...routes].sort(newestFirst)) {
      const stored = readRoute(kv, r.routeId);
      if (!stored) index = writeRoute(kv, r, index);
      else if (!index.some((s) => s.routeId === r.routeId)) index = indexRoute(kv, stored, index);
    }
    const indexed = new Set(readIndex(kv).map((s) => s.routeId));
    const complete =
      routes.length === legacy.length &&
      routes.every((r) => indexed.has(r.routeId) && readRoute(kv, r.routeId));
    if (complete) kv.remove(LEGACY_KEY);
  } catch {
    // Storage full or unavailable: the legacy blob stays, and the next launch
    // picks up where this one stopped. What did migrate is readable meanwhile.
  }
}

// Upsert one route's current state into the archive. Called on every persist so
// node changes are captured as they happen; it rewrites only this route's key
// and the small index.
export function archiveRoute(snap: RouteSnapshot) {
  if (!snap.routeId) return;
  const kv = store();
  if (!kv) return;
  try {
    migrateLegacy(kv);
    const now = new Date().toISOString();
    const index = readIndex(kv);
    const startedAt =
      index.find((s) => s.routeId === snap.routeId)?.startedAt ??
      readRoute(kv, snap.routeId)?.startedAt ??
      now;
    writeRoute(kv, { ...snap, startedAt, updatedAt: now }, index);
  } catch {
    // storage full or disabled — archiving is best-effort, never block the run
  }
}

// Summaries of every archived run, newest first. Cheap: reads only the index.
export function getArchivedRouteIndex(): ArchivedRouteSummary[] {
  const kv = store();
  if (!kv) return [];
  try {
    migrateLegacy(kv);
    return readIndex(kv).sort(newestFirst);
  } catch {
    return [];
  }
}

// One archived run in full, or undefined if it's missing or unreadable.
export function getArchivedRoute(routeId: string): ArchivedRoute | undefined {
  const kv = store();
  if (!kv) return undefined;
  try {
    migrateLegacy(kv);
    return readRoute(kv, routeId);
  } catch {
    return undefined;
  }
}

// Every archived run in full, newest first. Loads each run, so prefer
// getArchivedRouteIndex for lists and getArchivedRoute for a single run.
export function getArchivedRoutes(): ArchivedRoute[] {
  return getArchivedRouteIndex()
    .map((s) => getArchivedRoute(s.routeId))
    .filter((r): r is ArchivedRoute => r !== undefined)
    .sort(newestFirst);
}
