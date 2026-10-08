import { create } from "zustand";
import { planRoute, type PlanNode } from "../plan";
import { milesToMeters, type Pt } from "../geo";
import type { FootRoute, Turn } from "../brouter";
import type { Fountain, RecencyMode } from "../schemas";
import { useRun, type RunStop } from "./run";
import { corePorts } from "../configure";
import { ApiTimeoutError, isTransportError, readApiJson, type ApiReply } from "../apiResponse";

// Wizard step indices, mirroring the web StepProgress (where → radius → build →
// review). Kept here so core owns the phase→step mapping without importing web UI.
const BUILD_STEP_INDEX = 2;
const REVIEW_STEP_INDEX = 3;

// The planner's state and route-building I/O, moved out of the /plan page so
// the config wizard, route builder, and map feed can live in separate
// components without prop-drilling ~30 values. The planner is a single-instance
// surface (one /plan page), so a global store is safe — same pattern as
// store/run and store/outbox.

// Snapshot of an in-progress planner route, persisted so a refresh can resume it.
export type Draft = {
  center: Pt;
  tag: { key: string; value: string };
  radiusMi: number | "";
  recencyMode: RecencyMode;
  recencyMonths: number | "";
  targetMi: number | "";
  loop: boolean;
  fountains: Fountain[];
  pinnedIds: number[];
  excludedIds: number[];
  vias: Pt[];
  stops: Fountain[];
  line: [number, number][];
  distanceM: number;
  turns: Turn[];
  autoIds?: number[];
  autoCount: number;
  // The routed node order (vias included) and the user's direction choice.
  // Absent in drafts saved before they were persisted.
  order?: PlanNode[];
  reversed?: boolean;
};

export type PlannerPhase = "config" | "map" | "run";
export type SizeMode = "distance" | "points";
// Which request the current error came from, so a Retry re-runs that one: a
// failed route must not be "retried" by a fresh search, which drops the picks.
export type PlannerErrSource = "points" | "route";

// Ceilings against a dead connection, not budgets: past them the request is
// abandoned with a retryable error instead of spinning forever (a phone's HTTP
// stack may never time out a half-open socket). Both sit above the server's own
// upstream limits: BRouter gets 40 s, and a search may fall back across
// Overpass mirrors.
const ROUTE_TIMEOUT_MS = 60_000;
const POINTS_TIMEOUT_MS = 90_000;

// Module-scoped monotonic counters (the planner is a single-instance route).
// `planRequestSeq` and `pointsRequestSeq` drop results from requests that a
// newer one (or a resumed draft) superseded; `recenterSeq` forces the map to
// recenter even when coords repeat.
let planRequestSeq = 0;
let pointsRequestSeq = 0;
let recenterSeq = 0;

type PlannerState = {
  // "config" walks the questions; "map" hides them to build the route; "run"
  // takes the SAME map live for the survey, swapping only the side panel.
  phase: PlannerPhase;
  step: number;

  center: Pt | null;
  vias: Pt[];
  pinnedIds: number[];
  recenterKey: string;
  // Whether the pending recenter should animate (flyTo) instead of jump.
  animateRecenter: boolean;
  addr: string;
  radiusMi: number | "";
  // Recency filter: by default surface points NOT surveyed in the last 6 months
  // (the ones worth verifying on the ground). "fresh" flips it; "any" disables.
  recencyMode: RecencyMode;
  recencyMonths: number | "";
  targetMi: number | "";
  // How the route is sized: to a target distance, or purely by the points picked.
  sizeMode: SizeMode;
  loop: boolean;
  tag: { key: string; value: string };

  fountains: Fountain[];
  stops: Fountain[];
  // The committed route's nodes in visit order, via-points included (`stops`
  // keeps only the fountains). Reversing works from this, so vias survive it.
  order: PlanNode[];
  // The user asked for the route the other way round. planRoute picks a
  // direction on its own, so every re-plan applies this to keep the choice.
  reversed: boolean;
  // The picks, via-points or loop changed since `stops`/`line` were committed
  // (a re-plan is in flight or failed), so they no longer match the selection
  // on the map. Starting a run from them would run the old route.
  routeStale: boolean;
  // Points the user explicitly took OUT of the route (e.g. auto-grabbed ones they
  // don't want). They stay excluded so re-planning / auto-pickup won't re-add them.
  excludedIds: number[];
  line: [number, number][];
  distanceM: number;
  turns: Turn[];
  // True once a route is built; gates auto-replan so picks/removes update the
  // route live without re-running the whole planner by hand.
  hasRoute: boolean;
  // Coords of a point BRouter can't reach on foot ("target island").
  islandPt: Pt | null;
  // Fountains auto-grabbed via small detour pickup.
  autoIds: number[];
  // How many stops were auto-grabbed (tiny detour off the route).
  autoCount: number;
  busy: string | null;
  err: string | null;
  // Whether the current error is a transient failure (offline, timed out, a
  // server or upstream hiccup) that the same request can get past.
  errRetryable: boolean;
  errSource: PlannerErrSource | null;

  // Session recovery: a saved route from a previous (interrupted) session, and a
  // gate so we don't persist a draft until the initial load has run.
  resumable: Draft | null;
  draftReady: boolean;

  setPhase: (phase: PlannerPhase) => void;
  setStep: (step: number) => void;
  setAddr: (addr: string) => void;
  setRadiusMi: (v: number | "") => void;
  setRecencyMode: (m: RecencyMode) => void;
  setRecencyMonths: (v: number | "") => void;
  setTargetMi: (v: number | "") => void;
  setSizeMode: (m: SizeMode) => void;
  setLoop: (loop: boolean) => void;
  setErr: (err: string | null) => void;

  recenter: (p: Pt, animate?: boolean) => void;
  geolocate: () => void;
  searchAddr: () => Promise<void>;
  findPoints: () => Promise<void>;
  finishConfig: () => Promise<void>;
  planAndRoute: () => Promise<void>;
  // Re-plan the current selection after a failed route (never a fresh search,
  // which would drop the picks).
  retryRoute: () => Promise<void>;
  replan: () => void;
  makeRoute: () => Promise<void>;
  reverseRoute: () => Promise<void>;
  addStop: (id: number) => void;
  removeStop: (id: number) => void;
  toggleStop: (id: number) => void;
  restoreStop: (id: number) => void;
  mapClick: (lat: number, lon: number) => void;
  addVia: (lat: number, lon: number) => void;
  removeVia: (i: number) => void;
  loadDraft: () => Promise<void>;
  // Restore a saved route. Pass the draft the resume offer was made with: a
  // search that started meanwhile clears `resumable`, and the user's choice
  // must still apply.
  resumeDraft: (d?: Draft) => void;
  dismissDraft: () => void;
  // Resolves true once the run is set up; false when there is nothing to run
  // or the route is still catching up (with `err` saying why), so the caller
  // stays on the planner instead of opening an empty run.
  startRun: () => Promise<boolean>;
  // The state-clearing half of leaving a finished run; the page also resets the
  // run session. Keeps the start area so the surveyor can build another route.
  resetAfterRun: () => void;
};

// Derived helpers (plain functions so components can memo over primitive slices).

// The user pins, resolved to fountains and forced into the route. Excluded
// points can never be pinned (removing a point also unpins it).
export function pinnedOf(s: Pick<PlannerState, "fountains" | "pinnedIds" | "excludedIds">) {
  return s.fountains.filter((f) => s.pinnedIds.includes(f.id) && !s.excludedIds.includes(f.id));
}

// Points the user removed from the route, resolved to fountains for the list.
export function removedOf(s: Pick<PlannerState, "fountains" | "excludedIds">) {
  return s.fountains.filter((f) => s.excludedIds.includes(f.id));
}

// A point is "in the route" if it's a chosen stop or a required pin (and not
// explicitly removed). Drives marker color + the popup's add/remove toggle.
export function inRouteIdsOf(s: Pick<PlannerState, "stops" | "pinnedIds" | "excludedIds">) {
  const ids = new Set<number>(s.pinnedIds);
  s.stops.forEach((f) => ids.add(f.id));
  s.excludedIds.forEach((id) => ids.delete(id));
  return ids;
}

// Whether the map should search for points on its own: a start is known,
// nothing is loaded or loading, no error is waiting on the user, and any saved
// route has been offered and turned down. Searching while the resume offer is
// open would wipe the stops the user is about to restore.
export function shouldAutoFindPoints(s: {
  center: Pt | null;
  phase: PlannerPhase;
  fountainsCount: number;
  busy: string | null;
  err: string | null;
  draftReady: boolean;
  resumable: Draft | null;
}): boolean {
  return (
    s.center !== null &&
    s.phase === "map" &&
    s.fountainsCount === 0 &&
    s.busy === null &&
    !s.err &&
    s.draftReady &&
    !s.resumable
  );
}

const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";
const TOO_SLOW = "The server took too long to answer. Check your connection and try again.";
const UNEXPECTED_REPLY = "The server sent an unexpected reply. Please try again.";

// One call to our API, as a reply that never throws for network reasons. A
// request that got no answer (offline, timed out, a captive portal) becomes a
// retryable failure with a plain message, the same as a non-JSON error page,
// instead of "Network request failed" or a JSON parse error with no Retry.
async function callApi<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  fallback: string,
): Promise<ApiReply<T>> {
  let r: Response;
  try {
    r = await corePorts().api.apiFetch(path, init, { timeoutMs });
  } catch (e) {
    if (!isTransportError(e)) throw e;
    const message = e instanceof ApiTimeoutError ? TOO_SLOW : UNREACHABLE;
    return { ok: false, status: 0, message, retryable: true, body: undefined };
  }
  return readApiJson<T>(r, fallback);
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// The map geometry from a /api/route success, or null when the body isn't a
// route after all.
function routeGeometry(data: unknown): Pick<PlannerState, "line" | "distanceM" | "turns"> | null {
  const d = data as Partial<FootRoute> | null;
  if (!d || !Array.isArray(d.coords)) return null;
  return {
    // BRouter coords are [lon,lat]; the map line stores [lat,lon].
    line: d.coords.map(([lon, lat]) => [lat, lon]),
    distanceM: typeof d.distanceM === "number" ? d.distanceM : 0,
    turns: Array.isArray(d.turns) ? d.turns : [],
  };
}

// The error state for a failed /api/route reply (plan or reverse).
function routeFailure(reply: Extract<ApiReply<unknown>, { ok: false }>) {
  const island = (reply.body as { island?: Pt } | undefined)?.island;
  return {
    err: reply.message,
    errRetryable: reply.retryable,
    errSource: "route" as const,
    islandPt: island ?? null,
  };
}

const fountainsOf = (nodes: PlanNode[]) => nodes.filter((n) => n.fountain).map((n) => n.fountain!);

// Clearing an error clears what came with it, so a Retry never lingers under a
// message it doesn't belong to.
const noErr: Pick<PlannerState, "err" | "errRetryable" | "errSource"> = {
  err: null,
  errRetryable: false,
  errSource: null,
};

export const usePlanner = create<PlannerState>((set, get) => ({
  phase: "map",
  step: BUILD_STEP_INDEX,

  center: null,
  vias: [],
  pinnedIds: [],
  recenterKey: "init",
  animateRecenter: false,
  addr: "",
  radiusMi: 4,
  recencyMode: "stale",
  recencyMonths: 6,
  // Prefilled target so switching to distance mode lands ready-to-plan.
  targetMi: 3,
  sizeMode: "points",
  loop: true,
  tag: { key: "amenity", value: "drinking_water" },

  fountains: [],
  stops: [],
  order: [],
  reversed: false,
  routeStale: false,
  excludedIds: [],
  line: [],
  distanceM: 0,
  turns: [],
  hasRoute: true,
  islandPt: null,
  autoIds: [],
  autoCount: 0,
  busy: null,
  err: null,
  errRetryable: false,
  errSource: null,

  resumable: null,
  draftReady: false,

  // Navigating between steps/phases wipes any stale error from the step you left.
  setPhase: (phase) => set({ phase, ...noErr, islandPt: null }),
  setStep: (step) => set({ step, ...noErr, islandPt: null }),
  setAddr: (addr) => set({ addr }),
  setRadiusMi: (radiusMi) => set({ radiusMi }),
  setRecencyMode: (recencyMode) => set({ recencyMode }),
  setRecencyMonths: (recencyMonths) => set({ recencyMonths }),
  setTargetMi: (targetMi) => set({ targetMi }),
  setSizeMode: (sizeMode) => set({ sizeMode }),
  setLoop: (loop) => {
    set({ loop, routeStale: true });
    get().replan();
  },
  setErr: (err) => set({ ...noErr, err }),

  recenter: (p, animate = false) => {
    set({ center: p, recenterKey: `${p.lat},${p.lon},${++recenterSeq}`, animateRecenter: animate });
  },

  geolocate: () => {
    // A fix can take a while. If the start moved meanwhile (a tap on the map, a
    // resumed route), the user chose it: a late fix must not drag it away, and a
    // late failure is no longer worth an error.
    const before = get().center;
    set(noErr);
    corePorts()
      .geolocation.getCurrentPosition()
      .then((p) => {
        if (get().center === before) get().recenter({ lat: p.lat, lon: p.lon });
      })
      .catch((e) => {
        if (get().center === null) set({ err: `Geolocation failed: ${(e as Error).message}` });
      });
  },

  searchAddr: async () => {
    const { addr } = get();
    if (!addr.trim()) return;
    set({ busy: "search", err: null });
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(addr)}`,
      );
      const j = (await r.json()) as { lat: string; lon: string }[];
      if (j[0]) get().recenter({ lat: Number(j[0].lat), lon: Number(j[0].lon) });
      else set({ err: "Address not found" });
    } catch (e) {
      set({ err: (e as Error).message });
    } finally {
      set({ busy: null });
    }
  },

  findPoints: async () => {
    const { center, radiusMi, tag, recencyMonths } = get();
    if (!center) return;
    const seq = ++pointsRequestSeq;
    const fresh = () => seq === pointsRequestSeq;
    // A route still in flight belongs to the selection being wiped here.
    ++planRequestSeq;
    // Building fresh — drop any pending resume offer so the new route persists.
    set({
      resumable: null,
      busy: "find",
      ...noErr,
      stops: [],
      order: [],
      reversed: false,
      routeStale: true,
      line: [],
      turns: [],
      pinnedIds: [],
      excludedIds: [],
      autoIds: [],
      autoCount: 0,
      hasRoute: false,
      islandPt: null,
    });
    try {
      const reply = await callApi<{ fountains?: Fountain[] }>(
        "/api/fountains",
        postJson({
          ...center,
          radiusM: milesToMeters(radiusMi || 0),
          tag,
          // Recency is fixed to stale: only points not checked within the window.
          recencyMode: "stale",
          recencyMonths: recencyMonths || 6,
        }),
        POINTS_TIMEOUT_MS,
        "Couldn't load points. Please try again.",
      );
      if (!fresh()) return;
      const fountains = reply.ok ? reply.data?.fountains : undefined;
      if (!reply.ok || !Array.isArray(fountains)) {
        set({
          err: reply.ok ? UNEXPECTED_REPLY : reply.message,
          errRetryable: reply.ok || reply.retryable,
          errSource: "points",
        });
        return;
      }
      set({ fountains });
      if (fountains.length === 0) {
        set({ err: "No matching points in radius.", errSource: "points" });
      }
    } catch (e) {
      if (fresh()) set({ err: (e as Error).message, errRetryable: false, errSource: "points" });
    } finally {
      if (fresh()) set({ busy: null });
    }
  },

  // Last config step: hand the screen to the map's build step right away and
  // fit the viewport to the search area (recenterKey bump → the plan page's
  // fitPoints re-fit), so the points load INTO an already-framed map instead of
  // popping in off-screen. The search runs after, streaming into that frame.
  finishConfig: async () => {
    set({
      phase: "map",
      step: BUILD_STEP_INDEX,
      recenterKey: `fit-${++recenterSeq}`,
      sizeMode: "points",
      hasRoute: true,
    });
    await get().findPoints();
  },

  // Plan + fetch street geometry. Unlike the old page-local version there is no
  // override threading: store actions write state synchronously, so `get()`
  // always sees the latest picks.
  planAndRoute: async () => {
    const { center, fountains, pinnedIds, excludedIds, vias, loop, sizeMode, targetMi, reversed } =
      get();
    if (!center || fountains.length === 0) return;
    // In points mode the route is sized purely by what the user picks, so the
    // target distance is ignored even if a value is left in the field.
    const target = sizeMode === "distance" ? targetMi || 0 : 0;
    // Rapid taps fire overlapping plans; only the latest may write results, so a
    // slow earlier fetch can't clobber a newer route.
    const seq = ++planRequestSeq;
    const fresh = () => seq === planRequestSeq;
    set({ busy: "route", ...noErr, islandPt: null });
    try {
      const { ordered, autoIds } = planRoute({
        start: center,
        // Excluded points are out of the running entirely — never re-picked.
        candidates: fountains.filter((f) => !excludedIds.includes(f.id)),
        vias,
        pinned: fountains.filter((f) => pinnedIds.includes(f.id) && !excludedIds.includes(f.id)),
        targetM: milesToMeters(target),
        loop,
      });
      const order = reversed ? [...ordered].reverse() : ordered;
      if (order.length === 0) {
        if (!fresh()) return;
        const err =
          sizeMode === "distance"
            ? "No points fit that distance. Increase target distance or add via-points."
            : excludedIds.length > 0 || pinnedIds.length > 0
              ? "No points left in the route — add one back or pin a point."
              : null;
        set({
          err,
          errSource: err ? "route" : null,
          stops: [],
          order: [],
          line: [],
          distanceM: 0,
          turns: [],
          autoIds: [],
          autoCount: 0,
          routeStale: false,
        });
        return;
      }
      const points = [center, ...order.map((n) => ({ lat: n.lat, lon: n.lon }))];
      const reply = await callApi<FootRoute>(
        "/api/route",
        postJson({ points, loop }),
        ROUTE_TIMEOUT_MS,
        "Couldn't plan the route. Please try again.",
      );
      if (!fresh()) return; // a newer plan superseded this one
      if (!reply.ok) {
        set(routeFailure(reply));
        return;
      }
      const geometry = routeGeometry(reply.data);
      if (!geometry) {
        set({ err: UNEXPECTED_REPLY, errRetryable: true, errSource: "route" });
        return;
      }
      set({
        ...geometry,
        stops: fountainsOf(order),
        order,
        autoIds,
        autoCount: autoIds.length,
        hasRoute: true,
        routeStale: false,
      });
    } catch (e) {
      if (fresh()) set({ err: (e as Error).message, errRetryable: false, errSource: "route" });
    } finally {
      if (fresh()) set({ busy: null });
    }
  },

  retryRoute: () => get().planAndRoute(),

  // Once a route exists (or in waypoints mode), every membership change re-plans immediately.
  replan: () => {
    if (get().hasRoute || get().sizeMode === "points") get().planAndRoute();
  },

  // "Plan route" button: validate inputs, then build.
  makeRoute: async () => {
    const s = get();
    if (!s.center || s.fountains.length === 0) return;
    const target = s.sizeMode === "distance" ? s.targetMi || 0 : 0;
    if (s.sizeMode === "distance" && target <= 0) {
      set({ ...noErr, err: "Enter a target distance." });
      return;
    }
    // Points mode: the route is sized by the points the user picks — so they have
    // to pick at least one (a pin or a waypoint) to define it.
    if (s.sizeMode === "points" && pinnedOf(s).length === 0 && s.vias.length === 0) {
      set({ ...noErr, err: "Pin a point or add a waypoint to size your route." });
      return;
    }
    await get().planAndRoute();
  },

  // Flip the visiting order of the route. Start (your location) stays fixed; the
  // nodes (via-points included) are walked in reverse, and the street geometry
  // is re-fetched so one-way streets and turn costs are respected in the new
  // direction. On success the choice sticks: later re-plans keep this direction.
  reverseRoute: async () => {
    const { center, order, stops, busy, loop, reversed, routeStale } = get();
    if (!center || busy !== null) return;
    if (routeStale || (order.length === 0 && stops.length > 0)) {
      // The committed order doesn't match the selection (the last re-plan
      // failed), or isn't known (a route resumed from an older draft): re-plan
      // the current selection in the other direction instead.
      set({ reversed: !reversed, routeStale: true });
      await get().planAndRoute();
      return;
    }
    if (order.length < 2) return;
    const next = [...order].reverse();
    set({ busy: "reverse", ...noErr, islandPt: null });
    const seq = ++planRequestSeq;
    const fresh = () => seq === planRequestSeq;
    try {
      const points = [center, ...next.map((n) => ({ lat: n.lat, lon: n.lon }))];
      const reply = await callApi<FootRoute>(
        "/api/route",
        postJson({ points, loop }),
        ROUTE_TIMEOUT_MS,
        "Couldn't reverse the route. Please try again.",
      );
      if (!fresh()) return;
      // On failure the committed route still stands, in its old direction.
      if (!reply.ok) {
        set(routeFailure(reply));
        return;
      }
      const geometry = routeGeometry(reply.data);
      if (!geometry) {
        set({ err: UNEXPECTED_REPLY, errRetryable: true, errSource: "route" });
        return;
      }
      set({ ...geometry, order: next, stops: fountainsOf(next), reversed: !reversed });
    } catch (e) {
      if (fresh()) set({ err: (e as Error).message, errRetryable: false, errSource: "route" });
    } finally {
      if (fresh()) set({ busy: null });
    }
  },

  // Force a point into the route (pin it) and clear any prior removal.
  addStop: (id) => {
    const { pinnedIds, excludedIds } = get();
    set({
      excludedIds: excludedIds.filter((x) => x !== id),
      pinnedIds: pinnedIds.includes(id) ? pinnedIds : [...pinnedIds, id],
      routeStale: true,
    });
    get().replan();
  },

  // Take a point out of the route and keep it out: exclude it (so re-planning /
  // auto-pickup won't grab it again) and drop any pin.
  removeStop: (id) => {
    const { pinnedIds, excludedIds } = get();
    set({
      pinnedIds: pinnedIds.filter((x) => x !== id),
      excludedIds: excludedIds.includes(id) ? excludedIds : [...excludedIds, id],
      routeStale: true,
    });
    get().replan();
  },

  // Tap a marker to add it; tap again to remove it. The route re-plans on every
  // change.
  toggleStop: (id) => {
    if (inRouteIdsOf(get()).has(id)) get().removeStop(id);
    else get().addStop(id);
  },

  // Undo a removal: let the planner consider the point again (it may be re-picked
  // by distance fill or small-detour pickup).
  restoreStop: (id) => {
    set({ excludedIds: get().excludedIds.filter((x) => x !== id), routeStale: true });
    get().replan();
  },

  mapClick: (lat, lon) => {
    const { phase, center, vias } = get();
    // Without a start (location denied, or no fix yet) a tap sets it, in any
    // phase, and clears the geolocation error so the search can run. Config
    // phase also lets a tap move an existing start.
    if (!center || phase === "config") {
      get().recenter({ lat, lon });
      if (!center) set(noErr);
      return;
    }
    // Map phase: a click drops a pass-through waypoint.
    set({ vias: [...vias, { lat, lon }], routeStale: true });
    get().replan();
  },

  // Drop a pass-through waypoint at the tapped spot and re-plan around it.
  // Called from the map's "Add a waypoint" popup on web; mobile drops vias on a
  // bare map tap via mapClick above.
  addVia: (lat, lon) => {
    const { center, vias } = get();
    if (!center) return;
    set({ vias: [...vias, { lat, lon }], routeStale: true });
    get().replan();
  },

  // Remove a pass-through waypoint and re-plan around the rest.
  removeVia: (i) => {
    set({ vias: get().vias.filter((_, j) => j !== i), routeStale: true });
    get().replan();
  },

  // On mount, look for a saved route from a prior session. If one exists (and no
  // route is already live in memory), offer to resume it rather than restoring
  // silently — the user may want a fresh plan.
  loadDraft: async () => {
    try {
      const r = await corePorts().api.apiFetch("/api/draft");
      const d = (await r.json()) as Draft | null;
      if (d && d.stops?.length && get().stops.length === 0) set({ resumable: d });
    } catch {
      // No draft (or it couldn't be read) — nothing to offer.
    } finally {
      set({ draftReady: true });
    }
  },

  // Restore a saved route into the planner and jump to the map.
  resumeDraft: (d = get().resumable ?? undefined) => {
    if (!d) return;
    // A search or plan still in flight would land on top of the restored route.
    ++pointsRequestSeq;
    ++planRequestSeq;
    get().recenter(d.center);
    set({
      busy: null,
      tag: d.tag,
      radiusMi: d.radiusMi,
      recencyMode: d.recencyMode ?? "stale",
      recencyMonths: d.recencyMonths ?? 6,
      targetMi: d.targetMi,
      loop: d.loop,
      fountains: d.fountains,
      pinnedIds: d.pinnedIds,
      excludedIds: d.excludedIds ?? [],
      vias: d.vias,
      stops: d.stops,
      // Without vias the stops are the whole order; with them and no saved
      // order, reverseRoute re-plans rather than guess where the vias go.
      order:
        d.order ??
        (d.vias.length === 0 ? d.stops.map((f) => ({ lat: f.lat, lon: f.lon, fountain: f })) : []),
      reversed: d.reversed ?? false,
      routeStale: false,
      line: d.line,
      distanceM: d.distanceM,
      turns: d.turns ?? [],
      autoIds: d.autoIds ?? [],
      autoCount: d.autoCount,
      hasRoute: d.stops.length > 0,
      ...noErr,
      resumable: null,
      phase: "map",
      // A saved draft with a built route resumes on the review step; otherwise
      // land on the build step to (re)plan.
      step: d.stops.length > 0 ? REVIEW_STEP_INDEX : BUILD_STEP_INDEX,
    });
  },

  // Drop the saved route — the user wants to start fresh.
  dismissDraft: () => {
    set({ resumable: null });
    corePorts()
      .api.apiFetch("/api/draft", { method: "DELETE" })
      .catch(() => {});
  },

  startRun: async () => {
    const { center, stops, pinnedIds, loop, tag, vias, fountains, line, distanceM, turns } = get();
    const effectiveStops =
      stops.length > 0 ? stops : fountains.filter((f) => pinnedIds.includes(f.id));
    if (!center || effectiveStops.length === 0) return false;
    if (get().routeStale) {
      // The stops and line on hand predate the latest change, so the run would
      // follow a route the map no longer shows. A route error already says why
      // (and carries the Retry), so only fill in when there is none.
      if (!get().err) {
        set({ err: "Your route is still updating. Try again once it has caught up." });
      }
      return false;
    }
    const runStops: RunStop[] = effectiveStops.map((f) => ({ ...f, status: "pending" }));
    const plan = {
      start: center,
      loop,
      tagKey: tag.key,
      tagValue: tag.value,
      stops: runStops,
      vias,
      pool: fountains,
      added: [],
      routeCoords: line.map(([lat, lon]) => [lon, lat] as [number, number]),
      distanceM,
      turns,
    };
    useRun.getState().setPlan(plan);
    // Route promoted to an active run; drop the planner draft so we don't re-offer it.
    corePorts()
      .api.apiFetch("/api/draft", { method: "DELETE" })
      .catch(() => {});
    // Stay on this map — just hand the side panel over to the live run.
    set({ phase: "run" });
    return true;
  },

  resetAfterRun: () =>
    set({
      stops: [],
      order: [],
      reversed: false,
      routeStale: false,
      line: [],
      turns: [],
      fountains: [],
      hasRoute: false,
      pinnedIds: [],
      excludedIds: [],
      vias: [],
      distanceM: 0,
      autoIds: [],
      autoCount: 0,
      step: BUILD_STEP_INDEX,
      phase: "map",
    }),
}));
