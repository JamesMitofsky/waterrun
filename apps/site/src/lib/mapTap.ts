// Hit-testing a tap against the dots a map draws on its canvas.
//
// A canvas gets none of the browser's touch adjustment, and MapLibre's own
// hit test is exact to the pixel: a finger landing a few px off a 16px dot
// opens nothing (or closes the card that was open). So a tap is tested as a
// box around the finger, and when that catches several dots the one nearest
// the tap wins.

export type ScreenPoint = { x: number; y: number };

/**
 * How far from a dot's centre a tap still counts as on it, in px: a 44px
 * target, the common touch-target guidance and about a fingertip's contact
 * patch.
 */
export const TAP_REACH_PX = 22;

/**
 * How far to grow the tap into a box, each way, for dots that already reach
 * `dotReachPx` from their centre (radius plus ring) — MapLibre counts a dot as
 * hit when its circle touches the box, so the dot's own size is already part
 * of the reach. Zero for a dot as big as the target or bigger.
 */
export function tapSlopPx(dotReachPx: number): number {
  return Math.max(0, TAP_REACH_PX - dotReachPx);
}

/**
 * The candidate whose screen position (`at`) is nearest `to`, or undefined for
 * none. A tie goes to the earlier candidate: MapLibre lists hits top-most
 * first, so between two dots equally near the tap, the one drawn on top — the
 * one an exact tap would have hit — is picked.
 */
export function nearestTo<T>(
  to: ScreenPoint,
  candidates: readonly T[],
  at: (c: T) => ScreenPoint,
): T | undefined {
  let best: T | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const p = at(c);
    const d = (p.x - to.x) ** 2 + (p.y - to.y) ** 2;
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}
