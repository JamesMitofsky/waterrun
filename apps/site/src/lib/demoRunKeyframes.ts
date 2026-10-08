/**
 * The hero's replay as CSS keyframes, for the loading frame to play before the
 * live map exists (`DemoRoutePlaceholder.astro`).
 *
 * Exact rather than sampled. The replay's clock (`runReplay.ts`) eases each leg
 * with a quadratic, and a quadratic piece of it is exactly a CSS
 * `cubic-bezier` (`easedSegments`). Between two keyframes the runner and the
 * line's tip move straight along one segment of the drawn polyline, so with a
 * keyframe at every vertex and at every change of quadratic, the browser's own
 * interpolation lands where `lengthAt` says the run is — at every frame, not
 * just at the samples.
 *
 * Everything is in a variant's frame pixels (see `offsetFromCenter`), the space
 * the placeholder's SVG `viewBox` uses.
 */

import { offsetFromCenter, type MapFrameVariant } from "./basemap/frames";
import {
  DEMO_LEGS,
  DEMO_ROUTE_LENGTHS,
  DEMO_RUN_END,
  DEMO_RUN_TIMING,
  demoRouteRunBy,
} from "./demoRun";
import { easedSegments } from "./runReplay";

/** Trim coordinates to a tenth of a pixel — past that it is bytes in the HTML. */
const r1 = (n: number) => Math.round(n * 10) / 10;
/** Keyframe values: finer, so the interpolated points between vertices stay on the line. */
const r2 = (n: number) => Math.round(n * 100) / 100;

export type FramePoint = { x: number; y: number };

/**
 * Where a point lands in a variant's frame, in CSS pixels from its top-left
 * corner, rounded as the placeholder draws it.
 */
export function framePoint(
  variant: MapFrameVariant,
  point: { lat: number; lon: number },
): FramePoint {
  const offset = offsetFromCenter(point, variant);
  return {
    x: r1(variant.frame.width / 2 + offset.x),
    y: r1(variant.frame.height / 2 + offset.y),
  };
}

/**
 * The run as the placeholder draws it in a variant's frame: the route up to
 * `DEMO_RUN_END`, vertex by vertex, and how to find the point — and the drawn
 * length — at any length along the route.
 *
 * Positions between vertices are interpolated along the *drawn* segment rather
 * than projected from the route, so a keyframe between two vertices sits on the
 * line the SVG actually strokes, and the dash that reveals that line ends
 * exactly under the runner.
 */
export function demoRunTrack(variant: MapFrameVariant) {
  const route = demoRouteRunBy(DEMO_RUN_END);
  const points = route.map(([lat, lon]) => framePoint(variant, { lat, lon }));
  // `routePrefix` keeps the route's vertices in order, then the tip: the
  // lengths along the route of every point drawn.
  const lens = route.map((_, i) =>
    i < route.length - 1 ? DEMO_ROUTE_LENGTHS.cum[i] : DEMO_RUN_END,
  );
  const drawn = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    drawn.push(drawn[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }

  /** The drawn point `length` along the route, and how far along the drawn line it is. */
  function at(length: number): FramePoint & { along: number } {
    if (length <= lens[0]) return { ...points[0], along: 0 };
    const last = points.length - 1;
    if (length >= lens[last]) return { ...points[last], along: drawn[last] };
    let i = 1;
    while (lens[i] < length) i++;
    const span = lens[i] - lens[i - 1];
    const t = span === 0 ? 0 : (length - lens[i - 1]) / span;
    const a = points[i - 1];
    const b = points[i];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      along: drawn[i - 1] + (drawn[i] - drawn[i - 1]) * t,
    };
  }

  return {
    points,
    /** Lengths along the route of each of `points`. */
    lens,
    /** The drawn line's whole length, in frame pixels. */
    length: drawn[drawn.length - 1],
    at,
  };
}

/** One keyframe of the run: the runner's position and the line's hidden remainder. */
export type RunKeyframe = {
  /** Offset into the run, as a CSS keyframe percentage of `DEMO_RUN_TIMING.runMs`. */
  pct: number;
  x: number;
  y: number;
  /** `stroke-dashoffset` for a dash the drawn run's length: how much of it is still hidden. */
  dash: number;
  /** Timing function to the next keyframe; absent on the last. */
  easing?: string;
};

/** The run's keyframes in a variant's frame, first stop to `DEMO_RUN_END`. */
export function demoRunKeyframes(variant: MapFrameVariant): RunKeyframe[] {
  const track = demoRunTrack(variant);
  const { runMs } = DEMO_RUN_TIMING;
  const segments = easedSegments(DEMO_LEGS, track.lens);
  const keyframe = (ms: number, length: number, easing?: string): RunKeyframe => {
    const p = track.at(length);
    return {
      pct: Math.round((ms / runMs) * 1e6) / 1e4,
      x: r2(p.x),
      y: r2(p.y),
      dash: r2(track.length - p.along),
      ...(easing ? { easing } : {}),
    };
  };
  const out = segments.map((s) =>
    keyframe(
      s.fromMs,
      s.fromLen,
      `cubic-bezier(${s.bezier.map((n) => Math.round(n * 1e5) / 1e5).join(",")})`,
    ),
  );
  const end = segments[segments.length - 1];
  out.push(keyframe(end.toMs, end.toLen));
  return out;
}

/**
 * `@keyframes` for the runner (`<name>-runner`, a `transform`) and the line
 * (`<name>-line`, a `stroke-dashoffset`), each carrying the per-keyframe
 * timing functions that make them exact.
 */
export function demoRunKeyframesCss(name: string, keyframes: RunKeyframe[]): string {
  const block = (value: (k: RunKeyframe) => string) =>
    keyframes
      .map(
        (k) => `${k.pct}%{${value(k)}${k.easing ? `;animation-timing-function:${k.easing}` : ""}}`,
      )
      .join("");
  return (
    `@keyframes ${name}-runner{${block((k) => `transform:translate(${k.x}px,${k.y}px)`)}}` +
    `@keyframes ${name}-line{${block((k) => `stroke-dashoffset:${k.dash}`)}}`
  );
}
