/**
 * The small white marks drawn on top of a map dot to say what its colour
 * means without relying on colour alone: an X, a question mark.
 *
 * They are SDF images drawn in code, for the same reason as the city dot in
 * `basemap/placeDot.ts`: the sprite we load has no SDF images, and only an SDF
 * image stays sharp at any size and takes its colour from the layer.
 * `MapView` adds each from the map's `styleimagemissing` event the first time
 * a marker asks for it.
 */
export type MarkerGlyph = "x" | "question";

const ID_PREFIX = "marker-glyph-";

/** The image id a glyph is registered under on the map. */
export const markerGlyphImageId = (glyph: MarkerGlyph): string => ID_PREFIX + glyph;

/** The glyph an image id names, or null when the id is not one of ours. */
export function markerGlyphOfImageId(id: string): MarkerGlyph | null {
  if (!id.startsWith(ID_PREFIX)) return null;
  const glyph = id.slice(ID_PREFIX.length);
  return glyph in STROKES ? (glyph as MarkerGlyph) : null;
}

/**
 * The image is a square box that stands for the dot's full diameter, so the
 * layer scales it with `icon-size = diameter / MARKER_GLYPH_BOX_PX` and the
 * glyph keeps its place and proportion inside any size of dot.
 */
export const MARKER_GLYPH_BOX_PX = 32;

/** MapLibre's SDF encoding; see `basemap/placeDot.ts`. */
const SDF_EDGE = 0.75;
const SDF_PX = 8;

type Pt = readonly [number, number];
type Segment = readonly [Pt, Pt];

/**
 * Half the stroke's width, in units of the dot's radius (the box runs -1..1,
 * y down). Round caps and joins come free: a stroke is every point within
 * this distance of a segment.
 */
const HALF_STROKE = 0.15;

/** Points along an arc, angles in degrees clockwise from 3 o'clock. */
function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): Pt[] {
  const steps = 16;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
}

const polyline = (pts: Pt[]): Segment[] => pts.slice(1).map((p, i) => [pts[i]!, p] as const);

const STROKES: Record<MarkerGlyph, Segment[]> = {
  x: [
    [
      [-0.4, -0.4],
      [0.4, 0.4],
    ],
    [
      [-0.4, 0.4],
      [0.4, -0.4],
    ],
  ],
  question: [
    // The hook: from 9 o'clock over the top and round to the lower right,
    // then in to the stem.
    ...polyline([...arc(0, -0.27, 0.27, 180, 410), [0, 0.08], [0, 0.18]]),
    // The dot, a stroke of no length.
    [
      [0, 0.52],
      [0, 0.52],
    ],
  ],
};

function distanceToSegment(px: number, py: number, [[ax, ay], [bx, by]]: Segment): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * A glyph as an SDF image, ready for
 * `map.addImage(markerGlyphImageId(glyph), image, { sdf: true })`.
 *
 * Distances are measured from each pixel's centre. Only alpha is read for an
 * SDF image; the colour channels are left at zero.
 */
export function markerGlyphImage(glyph: MarkerGlyph): {
  width: number;
  height: number;
  data: Uint8ClampedArray;
} {
  const box = MARKER_GLYPH_BOX_PX;
  const half = box / 2;
  const segments = STROKES[glyph];
  const data = new Uint8ClampedArray(box * box * 4);
  for (let y = 0; y < box; y++) {
    for (let x = 0; x < box; x++) {
      const ux = (x + 0.5 - half) / half;
      const uy = (y + 0.5 - half) / half;
      let nearest = Infinity;
      for (const s of segments) nearest = Math.min(nearest, distanceToSegment(ux, uy, s));
      // Positive outside the stroke, negative inside, in pixels.
      const distance = (nearest - HALF_STROKE) * half;
      // The clamped array rounds and clamps to 0..255.
      data[(y * box + x) * 4 + 3] = (SDF_EDGE - distance / SDF_PX) * 255;
    }
  }
  return { width: box, height: box, data };
}
