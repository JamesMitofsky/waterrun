/**
 * The clock of a replayed run: a runner who sets off from one point, slows
 * into the next, and so on down a list of checkpoints, finishing the whole
 * thing in a fixed time.
 *
 * Pure arithmetic over lengths and milliseconds, so the component that plays
 * it (`DemoRunMap.svelte`) holds only the frame loop, and this can be checked
 * without one. The lengths are whatever unit the caller measures the route
 * in — `routeProgress` — and never converted here.
 */

/** One stretch between checkpoints: what is run, and when. */
export type Leg = {
  /** Time the runner leaves the leg's start, ms from the replay's start. */
  fromMs: number;
  /** Time the runner arrives at the leg's end. */
  toMs: number;
  /** Length along the route the leg starts at. */
  fromLen: number;
  /** Length along the route the leg ends at. */
  toLen: number;
};

/**
 * Quadratic ease in and out: at rest at both ends, fastest in the middle.
 * The shape of a runner leaving one point and pulling up at the next.
 */
export function easeInOut(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u < 0.5 ? 2 * u * u : 1 - ((-2 * u + 2) * (-2 * u + 2)) / 2;
}

/**
 * Split `totalMs` across the legs between consecutive `checkpoints` — lengths
 * along the route, ascending — in proportion to each leg's length, so the
 * runner's average pace is the same on every leg. Repeated checkpoints (two
 * stops at the same point) make no leg. Fewer than two distinct checkpoints
 * make no legs at all.
 */
export function legSchedule(checkpoints: number[], totalMs: number): Leg[] {
  const points = [...new Set(checkpoints)].sort((a, b) => a - b);
  const span = points.length ? points[points.length - 1] - points[0] : 0;
  if (span <= 0) return [];
  const legs: Leg[] = [];
  let at = 0;
  for (let i = 1; i < points.length; i++) {
    const fromLen = points[i - 1];
    const toLen = points[i];
    const ms = (totalMs * (toLen - fromLen)) / span;
    legs.push({ fromMs: at, toMs: at + ms, fromLen, toLen });
    at += ms;
  }
  // The sum above can land a hair off `totalMs`; the last arrival is exact.
  legs[legs.length - 1].toMs = totalMs;
  return legs;
}

/**
 * How far along the route the runner is `ms` into a schedule: the start
 * before it begins, the end after it is over, and in between, eased along
 * whichever leg is under way.
 */
export function lengthAt(legs: Leg[], ms: number): number {
  if (!legs.length) return 0;
  if (ms <= legs[0].fromMs) return legs[0].fromLen;
  const last = legs[legs.length - 1];
  if (ms >= last.toMs) return last.toLen;
  const leg = legs.find((l) => ms < l.toMs) ?? last;
  const u = (ms - leg.fromMs) / (leg.toMs - leg.fromMs);
  return leg.fromLen + (leg.toLen - leg.fromLen) * easeInOut(u);
}

/**
 * When the runner arrives at `length` along the route: the end of the leg
 * that ends there, or the start of the schedule for its first checkpoint.
 * `undefined` for a length that is not a checkpoint.
 */
export function arrivalMs(legs: Leg[], length: number): number | undefined {
  if (!legs.length) return undefined;
  if (length === legs[0].fromLen) return legs[0].fromMs;
  return legs.find((l) => l.toLen === length)?.toMs;
}

/**
 * When the runner is `length` along the route — the inverse of
 * {@link lengthAt}, for any length rather than only a checkpoint. The start of
 * the schedule for a length at or before its first checkpoint, the end for one
 * at or past its last.
 */
export function timeAt(legs: Leg[], length: number): number {
  if (!legs.length) return 0;
  if (length <= legs[0].fromLen) return legs[0].fromMs;
  const last = legs[legs.length - 1];
  if (length >= last.toLen) return last.toMs;
  const leg = legs.find((l) => length <= l.toLen) ?? last;
  const f = (length - leg.fromLen) / (leg.toLen - leg.fromLen);
  // `easeInOut` solved for u, on whichever of its two halves `f` falls.
  const u = f <= 0.5 ? Math.sqrt(f / 2) : 1 - Math.sqrt((1 - f) / 2);
  return leg.fromMs + (leg.toMs - leg.fromMs) * u;
}

/** The slope of {@link easeInOut}. */
const easeInOutSlope = (u: number) => (u < 0.5 ? 4 * u : 4 * (1 - u));

/**
 * Cuts of a leg closer together than this, in ms, are one cut. A stretch
 * shorter than this is not a keyframe any browser could land on.
 */
const MIN_SEGMENT_MS = 0.01;

/** A stretch of a schedule over which length is one quadratic in time. */
export type EasedSegment = {
  fromMs: number;
  toMs: number;
  fromLen: number;
  toLen: number;
  /**
   * `cubic-bezier(x1, y1, x2, y2)` that goes 0 → 1 over the segment's time
   * exactly as its length goes `fromLen` → `toLen`.
   */
  bezier: [number, number, number, number];
};

/**
 * A schedule cut into stretches over each of which length is a single
 * quadratic in time — which makes each stretch, exactly, a CSS `cubic-bezier`,
 * for a caller replaying the schedule as keyframes instead of in a frame loop.
 *
 * Every leg is cut at its midpoint, where {@link easeInOut} changes from one
 * quadratic to the other, and wherever it passes one of `breaks` — lengths
 * along the route at which a caller needs a keyframe of its own, such as the
 * vertices of the line a runner follows, where interpolating straight between
 * keyframes would otherwise cut the corner.
 *
 * Why the bezier is exact: a quadratic y(s) rising from 0 to 1 is a quadratic
 * Bézier, and raised to a cubic its control points sit at x = 1/3 and x = 2/3 —
 * so x(t) = t, and the curve *is* the quadratic — at heights y'(0)/3 and
 * 1 − y'(1)/3.
 */
export function easedSegments(legs: Leg[], breaks: number[] = []): EasedSegment[] {
  const out: EasedSegment[] = [];
  for (const leg of legs) {
    const ms = leg.toMs - leg.fromMs;
    const dLen = leg.toLen - leg.fromLen;
    const minU = MIN_SEGMENT_MS / ms;
    // As fractions of the leg's time.
    const cuts = [0, 0.5, 1];
    const inner = breaks
      .filter((len) => len > leg.fromLen && len < leg.toLen)
      .map((len) => (timeAt([leg], len) - leg.fromMs) / ms)
      .sort((a, b) => a - b);
    for (const u of inner) {
      if (cuts.every((c) => Math.abs(c - u) >= minU)) cuts.push(u);
    }
    cuts.sort((a, b) => a - b);

    for (let i = 1; i < cuts.length; i++) {
      const u0 = cuts[i - 1];
      const u1 = cuts[i];
      const e0 = easeInOut(u0);
      const e1 = easeInOut(u1);
      // d(normalised length)/d(normalised time), from the leg's own slope.
      const scale = (u1 - u0) / (e1 - e0);
      out.push({
        fromMs: leg.fromMs + ms * u0,
        toMs: u1 === 1 ? leg.toMs : leg.fromMs + ms * u1,
        fromLen: leg.fromLen + dLen * e0,
        toLen: u1 === 1 ? leg.toLen : leg.fromLen + dLen * e1,
        bezier: [
          1 / 3,
          (easeInOutSlope(u0) * scale) / 3,
          2 / 3,
          1 - (easeInOutSlope(u1) * scale) / 3,
        ],
      });
    }
  }
  return out;
}
