/**
 * How a stop's dot, the runner, a stop's ping and its beckon are sized on every
 * map here — the shapes `MapView.svelte` draws, and the same shapes drawn
 * without the engine into a loading frame (`DemoRoutePlaceholder.astro`).
 *
 * A plain module for the reason `routeLine.ts` is one: the frame is rendered at
 * build time, where importing the map component would drag MapLibre into the
 * server build for a handful of numbers.
 */

/** A dot's radius when the caller gives no `markerRadius`. */
export const DEFAULT_MARKER_RADIUS = 9;

/** The white ring around every stop's dot, at full size. */
export const MARKER_STROKE_PX = 2;

/**
 * The runner dot: the line's own blue, ringed in white like the stops but
 * smaller than one, so it reads as moving along the route rather than as
 * another stop on it. 14px across.
 */
export const RUNNER_DOT = { radius: 7, stroke: 2.5 } as const;

/** How far a ping's ring grows past the dot's radius, as a multiple of it. */
export const PULSE_GROWTH = 1.4;

/** A ping ring's opacity at the moment it starts; it thins to nothing from there. */
export const PULSE_OPACITY = 0.5;

/**
 * How far past the dot's white ring a beckon's wave travels before it has
 * faded out.
 *
 * Set by the neighbours rather than by taste. The wave is laid over the map,
 * so it washes over anything it reaches — dot, white ring and label alike —
 * and on the landing hero's narrow layout the stop before the one beckoning is
 * under 40px away, centre to centre. 15px ends the wave just clear of that
 * stop's white ring.
 */
export const BECKON_REACH_PX = 15;

/**
 * How far through a ping, 0–1, its ring is first seen. The ring starts at the
 * dot's own radius and the dot is drawn over it, so the start of every ping is
 * hidden until the ring has grown past the dot's white ring. For a caller
 * lining something up with the moment a ping is seen to start.
 */
export function pulseVisibleAt(markerRadius = DEFAULT_MARKER_RADIUS): number {
  return MARKER_STROKE_PX / (markerRadius * PULSE_GROWTH);
}
