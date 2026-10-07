// Pure live-run guidance: given the current GPS fix, the active target, and the
// routed geometry, derive everything the HUD shows — distance/bearing to the
// next point, how far along the route we are, and the next turn-by-turn maneuver.
// Extracted from the web run hook so the Expo run hook derives it identically.
import { bearing, haversine, nearestCumDistOnPath, stopsAlongPath, type Pt } from "./geo";
import type { Turn } from "./brouter";

// Auto-arrival fires inside this radius; the proximity alert fires between the
// two (close enough to prep, not yet "here").
export const ARRIVAL_RADIUS_M = 30;
export const PROXIMITY_RADIUS_M = 80;

// A turn is "ahead" once we've passed within this margin of its vertex, so the
// HUD advances to the next maneuver a few meters before reaching it.
const TURN_LOOKAHEAD_M = 5;

// Slack around the stops that bound a guidance window. A stop is recorded from
// up to ARRIVAL_RADIUS_M away, so the runner can still be that far short of it
// when the next target becomes active.
const WINDOW_MARGIN_M = ARRIVAL_RADIUS_M;

export type RunGuidance = {
  distToTarget: number | null;
  bearingTo: number;
  traveledM: number;
  nextTurn: Turn | null;
  distToTurn: number | null;
  autoArrived: boolean;
};

// Stop positions depend only on the route and where its stops are, so they are
// projected once per route rather than on every GPS fix. Keyed by the coords
// array (stable for a run) and checked against the stops' positions, since a
// status change hands over a new stops array with the same points.
const stopsAlongCache = new WeakMap<[number, number][], { stops: Pt[]; along: number[] }>();

function stopsAlong(routeCoords: [number, number][], stops: readonly Pt[]): number[] {
  const hit = stopsAlongCache.get(routeCoords);
  if (
    hit &&
    hit.stops.length === stops.length &&
    hit.stops.every((s, i) => s.lat === stops[i].lat && s.lon === stops[i].lon)
  ) {
    return hit.along;
  }
  const along = stopsAlongPath(routeCoords, stops);
  stopsAlongCache.set(routeCoords, {
    stops: stops.map((s) => ({ lat: s.lat, lon: s.lon })),
    along,
  });
  return along;
}

// The stretch of the route ([minM, maxM] along it) a runner heading for
// stops[index] should be on: from just before the previous stop (or the start)
// to just past the target, or from the last stop to the end once every stop is
// done. Passing it to runGuidance keeps a fix on a retraced street (a dead-end
// spur to a fountain, the way back of an out-and-back loop) from snapping onto
// the earlier pass and announcing the turns already taken. It depends only on
// the route and the stop index, so it survives a cold start.
export function guidanceWindow(
  routeCoords: [number, number][],
  stops: readonly Pt[],
  index: number,
): [number, number] | undefined {
  if (routeCoords.length < 2 || stops.length === 0) return undefined;
  const along = stopsAlong(routeCoords, stops);
  const prev = Math.min(index, along.length) - 1;
  const minM = prev >= 0 ? along[prev] - WINDOW_MARGIN_M : -Infinity;
  const maxM = index < along.length ? along[Math.max(0, index)] + WINDOW_MARGIN_M : Infinity;
  return [minM, maxM];
}

export function runGuidance(
  pos: Pt | null,
  target: Pt | null,
  routeCoords: [number, number][],
  turns: Turn[],
  // Where along the route to look for the runner; see guidanceWindow.
  window?: [number, number],
): RunGuidance {
  const distToTarget = pos && target ? haversine(pos, target) : null;
  const bearingTo = pos && target ? bearing(pos, target) : 0;
  // Travel-relative maneuvers: where we are along the route (meters), then the
  // first precomputed turn still ahead of us.
  const traveledM =
    pos && routeCoords.length > 1 ? nearestCumDistOnPath(routeCoords, pos, window) : 0;
  const nextTurn = pos
    ? (turns.find((tn) => tn.distM > traveledM + TURN_LOOKAHEAD_M) ?? null)
    : null;
  const distToTurn = nextTurn ? nextTurn.distM - traveledM : null;
  const autoArrived = distToTarget != null && distToTarget < ARRIVAL_RADIUS_M;
  return { distToTarget, bearingTo, traveledM, nextTurn, distToTurn, autoArrived };
}
