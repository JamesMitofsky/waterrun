/**
 * The geometry of the run the hero replays: how far along the route each stop
 * is, where the run has got to, and what the map shows before and after.
 *
 * Shared between the island that plays the replay (`DemoRunMap.svelte`) and
 * the build-time placeholder drawn into its loading frame
 * (`DemoRoutePlaceholder.astro`), which has to show exactly the frame the
 * replay starts from — and, under reduced motion, exactly the frame it ends
 * on. Two copies of "which stops are reached at this point" would be two
 * copies to keep in step; both read this one.
 */

import type { StopStatus } from "@water-run/core/stores/run";
import { DC_FOUNTAINS, DC_ROUTE, DEMO_NEXT_STOP, SEED_STATUSES } from "./demoRoute";
import { arrivalLengths, pointAt, routeLengths, routePrefix, type Route } from "./routeProgress";

/** Cumulative lengths of `DC_ROUTE`, in the unit `routeProgress` measures. */
export const DEMO_ROUTE_LENGTHS = routeLengths(DC_ROUTE);

/** How far along `DC_ROUTE` the runner reaches each fountain, by id. */
export const DEMO_ARRIVALS = arrivalLengths(DC_ROUTE, DC_FOUNTAINS);

/** Ids of every fountain, in the order the route reaches them. */
const IN_ROUTE_ORDER = DC_FOUNTAINS.map((f) => f.id).sort(
  (a, b) => DEMO_ARRIVALS[a] - DEMO_ARRIVALS[b],
);

/** The surveyed stops (`SEED_STATUSES`), in the order the route reaches them. */
export const DEMO_SEEDED_IN_ORDER = IN_ROUTE_ORDER.filter((id) => id in SEED_STATUSES);

/**
 * Where the run has got to, as a length along `DC_ROUTE`: the runner's
 * arrival at `DEMO_NEXT_STOP`. Everything before it is drawn as run;
 * everything after is the plan. The replay halts exactly here, at the stop,
 * and opens its popup.
 *
 * The seed data is checked against the route at load rather than trusted: a
 * surveyed stop the runner has not reached, or a next stop that is already
 * surveyed, would replay as a run that marks a point before getting to it.
 */
export const DEMO_RUN_END = (() => {
  const end = DEMO_ARRIVALS[DEMO_NEXT_STOP];
  if (end === undefined) {
    throw new Error(`DEMO_NEXT_STOP ${DEMO_NEXT_STOP} is not one of DC_FOUNTAINS`);
  }
  if (DEMO_NEXT_STOP in SEED_STATUSES) {
    throw new Error(`DEMO_NEXT_STOP ${DEMO_NEXT_STOP} must not be in SEED_STATUSES`);
  }
  for (const id of DEMO_SEEDED_IN_ORDER) {
    if (DEMO_ARRIVALS[id] >= end) {
      throw new Error(`surveyed stop ${id} comes after DEMO_NEXT_STOP ${DEMO_NEXT_STOP}`);
    }
  }
  return end;
})();

/**
 * The lengths the replay comes to rest at, ascending: the start, every
 * surveyed stop, and the end at `DEMO_NEXT_STOP`. A runner sets off from
 * each and slows into the next — see `runReplay.ts` for the clock.
 */
export const DEMO_CHECKPOINTS: number[] = [
  ...new Set([0, ...DEMO_SEEDED_IN_ORDER.map((id) => DEMO_ARRIVALS[id]), DEMO_RUN_END]),
].sort((a, b) => a - b);

/** The runner's `[lat, lon]` when the run has got `length` along the route. */
export function demoRunnerAt(length: number): [number, number] {
  return pointAt(DC_ROUTE, DEMO_ROUTE_LENGTHS, length);
}

/** The part of the route run so far, when the run has got `length` along it. */
export function demoRouteRunBy(length: number): Route {
  return routePrefix(DC_ROUTE, DEMO_ROUTE_LENGTHS, length);
}

/**
 * The statuses on show when the run has got `length` along the route: the
 * seeded status of every surveyed stop the runner has reached, and nothing for
 * the rest, which a caller renders as pending.
 */
export function demoStatusesAt(length: number): Record<number, StopStatus> {
  const out: Record<number, StopStatus> = {};
  for (const id of DEMO_SEEDED_IN_ORDER) {
    if (DEMO_ARRIVALS[id] <= length) out[id] = SEED_STATUSES[id];
  }
  return out;
}
