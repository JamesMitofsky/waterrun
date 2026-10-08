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

import type { StopStatus } from "@rosm/core/stores/run";
import { DC_FOUNTAINS, DC_ROUTE, DEMO_NEXT_STOP, SEED_STATUSES } from "./demoRoute";
import { arrivalLengths, pointAt, routeLengths, routePrefix, type Route } from "./routeProgress";
import { arrivalMs, legSchedule } from "./runReplay";
import { pulseVisibleAt } from "./basemap/markerStyle";

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

/** How long a stop's ping lasts once the runner reaches it. */
const PULSE_MS = 550;

/**
 * The replay's timings, in ms. Shared by the live map that plays the replay
 * (`DemoRunMap.svelte`) and the loading frame that starts playing it first
 * (`DemoRoutePlaceholder.astro`): the two run on one clock
 * (`demoRunClock.ts`) and hand the run from one to the other mid-flight, so
 * they must count it the same way.
 */
export const DEMO_RUN_TIMING = {
  /**
   * Pause between the replay's clock starting — the page's first paint, or
   * the live map being ready when there is no frame to follow — and the run
   * setting off: a beat of settled map before anything on it moves.
   */
  holdMs: 400,
  /**
   * How long the run takes from the first stop to `DEMO_RUN_END`. Short: the
   * hero's copy is what the visitor came for, and the stop left beckoning at
   * the end is the replay's point, so the run is a prelude, not a feature.
   */
  runMs: 2200,
  pulseMs: PULSE_MS,
  /**
   * How long after the run ends at `DEMO_NEXT_STOP` that stop's beckon starts.
   *
   * Every surveyed stop changes colour the moment the runner reaches it and
   * pings from that moment too — but a ping's ring grows out from under the
   * dot, so it is first seen only once it has cleared the dot's white ring
   * (`pulseVisibleAt`). A beckon's first wave shows from its first frame.
   * Started on arrival it would lead every ping before it by that hidden
   * stretch; started this much later, `DEMO_NEXT_STOP` turns blue on arrival
   * like the others and its wave shows when a ping's ring would have.
   */
  beckonDelayMs: PULSE_MS * pulseVisibleAt(),
} as const;

/**
 * The replay's legs: one per stretch between checkpoints, each eased in and
 * out so the runner leaves a stop, gets up to pace, and slows into the next
 * (`runReplay.ts`). The time is shared out by distance, so the pace is the
 * same on every leg. Times are ms after the run sets off, `holdMs` in.
 */
export const DEMO_LEGS = legSchedule(DEMO_CHECKPOINTS, DEMO_RUN_TIMING.runMs);

/** When, in ms after the run sets off, the runner reaches each surveyed stop. */
export const DEMO_ARRIVAL_MS: Record<number, number> = Object.fromEntries(
  DEMO_SEEDED_IN_ORDER.map((id) => [id, arrivalMs(DEMO_LEGS, DEMO_ARRIVALS[id]) ?? 0]),
);

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
