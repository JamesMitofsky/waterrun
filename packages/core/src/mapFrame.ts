// Framing a map on a set of points: which box of the world to fit, and how
// much of the screen to fit it into. The run screen keeps the runner and their
// next stop in view this way, in the strip of map left between the status bar
// and the run panel that covers the bottom of it.
import { toRad, type Bounds, type Pt } from "./geo";

// Meters per degree of latitude (and of longitude at the equator).
const M_PER_DEG = 111_320;

// The smallest box a fit shows, edge to edge. A single point, or a runner
// standing at their stop, would otherwise zoom the map in as far as it goes;
// this keeps a few blocks in view, about zoom 16 on a phone.
export const FRAME_MIN_SPAN_M = 300;

// Kept clear around the framed points so a dot, and the number drawn on it,
// never sits on the edge of what's visible.
export const FRAME_MARGIN = 40;

// The framed area is never squeezed below this (points), however much of the
// map the screen's chrome covers: fitting a box into a sliver zooms out
// wildly, and an area with no room left can't be fitted at all.
export const FRAME_MIN_SIZE = 120;

export type FramePadding = { top: number; right: number; bottom: number; left: number };

// The [west, south, east, north] box (MapLibre's bounds order) around
// `points`, grown about its middle to at least `minSpanM` each way. Null when
// there is nothing to frame. A set straddling the antimeridian isn't handled.
export function frameBounds(points: readonly Pt[], minSpanM = FRAME_MIN_SPAN_M): Bounds | null {
  if (points.length === 0) return null;
  let s = Infinity;
  let n = -Infinity;
  let w = Infinity;
  let e = -Infinity;
  for (const p of points) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
  }
  const minLat = minSpanM / M_PER_DEG;
  // A degree of longitude shrinks toward the poles; the floor keeps the
  // division finite there.
  const minLon = minSpanM / (M_PER_DEG * Math.max(Math.cos(toRad((s + n) / 2)), 0.01));
  if (n - s < minLat) {
    const mid = (s + n) / 2;
    s = mid - minLat / 2;
    n = mid + minLat / 2;
  }
  if (e - w < minLon) {
    const mid = (w + e) / 2;
    w = mid - minLon / 2;
    e = mid + minLon / 2;
  }
  return [w, s, e, n];
}

// One axis of framePadding: the two covered edges plus the margin, unless that
// leaves less than FRAME_MIN_SIZE free, in which case both give way in
// proportion and the framed box reaches under the chrome rather than vanish.
function axisPadding(size: number, a: number, b: number): [number, number] {
  const want = Math.min(FRAME_MIN_SIZE, Math.max(size, 0));
  if (size - a - b >= want) return [a, b];
  const scale = Math.max(size - want, 0) / (a + b);
  return [a * scale, b * scale];
}

// Camera padding (points) that fits a framed box into the part of a
// `width` x `height` map the user can actually see: below `coverTop` (the
// status bar, and any controls drawn across the top) and above `coverBottom`
// (a panel drawn over the map).
export function framePadding(o: {
  width: number;
  height: number;
  coverTop: number;
  coverBottom: number;
}): FramePadding {
  const [top, bottom] = axisPadding(
    o.height,
    o.coverTop + FRAME_MARGIN,
    o.coverBottom + FRAME_MARGIN,
  );
  const [left, right] = axisPadding(o.width, FRAME_MARGIN, FRAME_MARGIN);
  return { top, right, bottom, left };
}
