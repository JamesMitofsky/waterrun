// Geo helpers: distance, bearing, unit conversion.

export type Pt = { lat: number; lon: number };

const R_EARTH_M = 6371000;
export const MILES_TO_M = 1609.344;

// Largest search radius we allow (meters), measured center→corner of the viewport.
// Caps how much OSM data a single query can pull: a viewport whose corner reaches
// past this is refused rather than sweeping a region/country of drinking-water
// nodes off the shared public Overpass mirrors. ~30 km comfortably covers a whole
// metro while blocking zoomed-way-out queries. Enforced both server-side (request
// schema) and client-side (the "Search this area" button gates on it). Because it
// is a real-world distance, the cap behaves identically on every screen size.
export const MAX_SEARCH_RADIUS_M = 30_000;

export function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function toDeg(r: number): number {
  return (r * 180) / Math.PI;
}

export function milesToMeters(mi: number): number {
  return mi * MILES_TO_M;
}

export function metersToMiles(m: number): number {
  return m / MILES_TO_M;
}

// A map viewport's [west, south, east, north] extent (MapLibre bounds order).
export type Bounds = [west: number, south: number, east: number, north: number];

// Center of a viewport bounds.
export function boundsCenter([w, s, e, n]: Bounds): Pt {
  return { lat: (s + n) / 2, lon: (w + e) / 2 };
}

// Radius (m) of the smallest circle covering the whole viewport: center to a
// corner. Lets a map's zoom drive the query size — zoom out, bigger radius.
export function boundsRadiusM(bounds: Bounds): number {
  const c = boundsCenter(bounds);
  const [, , e, n] = bounds;
  return haversine(c, { lat: n, lon: e });
}

export function metersToFeet(m: number): number {
  return m * 3.28084;
}

// Short-range distance in feet, switching to miles once far enough that a foot
// count is unwieldy. Used for turn-by-turn cues where feet read more naturally.
export function fmtFeet(m: number): string {
  const ft = metersToFeet(m);
  if (ft < 1000) return `${Math.round(ft / 5) * 5} ft`;
  return `${metersToMiles(m).toFixed(2)} mi`;
}

// Axis-aligned lat/lon box centered on `c`. `radiusM` is the vertical half-
// extent; the horizontal half-extent is `radiusM * aspect`, so passing the
// viewport's width/height ratio yields a box shaped like the screen (landscape →
// wider) instead of a square. Default aspect 1 is a square containing the circle.
// Returned as [[south, west], [north, east]] for Leaflet bounds.
export function boxAround(
  c: Pt,
  radiusM: number,
  aspect = 1,
): [[number, number], [number, number]] {
  const dLat = radiusM / 111320;
  const dLon = (radiusM * aspect) / (111320 * Math.cos(toRad(c.lat)));
  return [
    [c.lat - dLat, c.lon - dLon],
    [c.lat + dLat, c.lon + dLon],
  ];
}

// Width/height ratio of a lat/lon box in meters — the on-screen aspect ratio of
// a viewport with those bounds. >1 landscape, <1 portrait.
export function boxAspect(box: [[number, number], [number, number]]): number {
  const [[s, w], [n, e]] = box;
  const midLat = (s + n) / 2;
  const widthM = (e - w) * 111320 * Math.cos(toRad(midLat));
  const heightM = (n - s) * 111320;
  return heightM > 0 ? widthM / heightM : 1;
}

// Half-diagonal (center→corner) of a [south, west, north, east] bbox, in meters.
// Same metric as a viewport's center→corner search radius, so MAX_SEARCH_RADIUS_M
// caps circle and box queries on equal footing.
export function boundsHalfDiagonalM(bounds: [number, number, number, number]): number {
  const [s, w, n, e] = bounds;
  return haversine({ lat: (s + n) / 2, lon: (w + e) / 2 }, { lat: n, lon: e });
}

// Great-circle distance in meters between two points.
export function haversine(a: Pt, b: Pt): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Initial bearing from a to b, degrees clockwise from north (0..360).
export function bearing(a: Pt, b: Pt): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// 8-point compass label for a bearing.
export function compass(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// Human distance: feet under 1000 ft -> "395 ft", else miles "1.40 mi".
export function fmtDist(m: number): string {
  const ft = metersToFeet(m);
  if (ft < 1000) return `${Math.round(ft)} ft`;
  return `${metersToMiles(m).toFixed(2)} mi`;
}

// Where `p` projects onto a [lon,lat] polyline: meters along the path from its
// start, and meters off it. Projects onto each segment (flat-earth — fine at
// street scale) and keeps the first closest projection. With a [minM, maxM]
// window only that stretch of the path is considered, clamped to its ends.
function projectOnPath(
  coords: [number, number][],
  p: Pt,
  minM = -Infinity,
  maxM = Infinity,
): { alongM: number; offM: number } {
  // Local equirectangular meters/degree at this latitude.
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos(toRad(p.lat));
  const x = (lon: number) => lon * mPerLon;
  const y = (lat: number) => lat * mPerLat;
  const px = x(p.lon);
  const py = y(p.lat);
  let cum = 0;
  let best = Infinity;
  let bestAlong = 0;
  for (let i = 0; i < coords.length - 1 && cum <= maxM; i++) {
    const ax = x(coords[i][0]);
    const ay = y(coords[i][1]);
    const bx = x(coords[i + 1][0]);
    const by = y(coords[i + 1][1]);
    const dx = bx - ax;
    const dy = by - ay;
    const segLen = Math.hypot(dx, dy);
    if (cum + segLen >= minM) {
      let t = segLen > 0 ? ((px - ax) * dx + (py - ay) * dy) / (segLen * segLen) : 0;
      const lo = segLen > 0 ? Math.max(0, (minM - cum) / segLen) : 0;
      const hi = segLen > 0 ? Math.min(1, (maxM - cum) / segLen) : 0;
      t = Math.max(lo, Math.min(hi, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) {
        best = d;
        bestAlong = cum + t * segLen;
      }
    }
    cum += segLen;
  }
  return { alongM: bestAlong, offM: best };
}

// A fix farther than this from the whole windowed stretch is off the route (a
// detour, or a stop skipped from afar), so the window no longer says where the
// runner is and the whole route is searched instead.
const WINDOW_OFF_ROUTE_M = 60;

// How far along a [lon,lat] polyline the point nearest `p` sits, in meters from
// the path start. Used to turn a live GPS fix into "meters traveled" for picking
// the next turn.
//
// Where the route retraces a street (out-and-back, a dead-end spur to a
// fountain) both passes are equally near and the first one wins, so a runner on
// the way back reads as still on the way out. `window` ([minM, maxM] along the
// path) limits the search to the stretch the runner should be on; see
// guidanceWindow in ./guidance.
export function nearestCumDistOnPath(
  coords: [number, number][],
  p: Pt,
  window?: [minM: number, maxM: number],
): number {
  if (coords.length < 2) return 0;
  if (window) {
    const near = projectOnPath(coords, p, window[0], window[1]);
    if (near.offM <= WINDOW_OFF_ROUTE_M) return near.alongM;
  }
  return projectOnPath(coords, p).alongM;
}

// Meters along a [lon,lat] polyline at which each stop is visited, in visit
// order. Stop k is searched for only from stop k−1's position onward: a route
// can pass a stop's spot more than once (it's on the way to an earlier stop, or
// the loop comes back along the same street), and only the pass after the
// previous stop is the visit. BRouter snaps each waypoint to the nearest way,
// so the visit is also the closest pass from there on.
export function stopsAlongPath(coords: [number, number][], stops: readonly Pt[]): number[] {
  if (coords.length < 2) return stops.map(() => 0);
  let from = 0;
  return stops.map((s) => (from = projectOnPath(coords, s, from).alongM));
}

// Human turn instruction for a signed turn angle (deg, + = right, − = left).
export function maneuver(angle: number): string {
  const a = Math.abs(angle);
  if (a < 20) return "Continue straight";
  const side = angle > 0 ? "right" : "left";
  if (a < 45) return `Slight ${side}`;
  if (a < 135) return `Turn ${side}`;
  if (a < 160) return `Sharp ${side}`;
  return "U-turn";
}

// The side a signed turn angle turns to, for copy too tight for maneuver()
// (the lock-screen "Left in 300 ft"). Turns are only extracted past 35°, so
// there is no "straight" case; a U-turn keeps its sign.
export function turnSide(angle: number): "left" | "right" {
  return angle < 0 ? "left" : "right";
}

// Total length (meters) of an ordered path, optionally closed back to start.
export function pathLength(pts: Pt[], loop: boolean): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += haversine(pts[i], pts[i + 1]);
  if (loop && pts.length > 1) total += haversine(pts[pts.length - 1], pts[0]);
  return total;
}

// The [lon,lat] point `distM` meters along a [lon,lat] polyline, clamped to the
// path's ends and linearly interpolated within the segment the distance lands
// in. The inverse of nearestCumDistOnPath: turn a "meters travelled" figure back
// into a position on the route. Segment lengths use haversine so it lines up with
// nearestCumDistOnPath to within rounding at street scale.
export function pointAtDistOnPath(coords: [number, number][], distM: number): [number, number] {
  if (coords.length === 0) return [0, 0];
  if (coords.length === 1 || distM <= 0) return coords[0];
  // A loop, not recursion: a long route has tens of thousands of vertices, more
  // stack frames than Hermes allows.
  let remaining = distM;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = haversine({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
    if (segLen === 0) continue;
    if (remaining <= segLen) {
      const t = remaining / segLen;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= segLen;
  }
  return coords[coords.length - 1];
}

// Forward heading (deg, 0 = north, clockwise) of the route at the point nearest
// `p`: the bearing from that projection to a point `lookaheadM` further along the
// route. This is the *direction of travel* along the path — unlike bearing(p,
// destination), which cuts straight to the goal and diverges from the road
// wherever the route bends. The look-ahead window smooths GPS/vertex jitter and
// eases the heading into an upcoming turn rather than snapping at each vertex.
// Within `lookaheadM` of the end the window would collapse, so it looks back
// along the final leg instead. Null when the route is too short to have a
// direction. Feeds the heading-up map.
export function routeHeadingAt(coords: [number, number][], p: Pt, lookaheadM = 25): number | null {
  if (coords.length < 2) return null;
  const traveled = nearestCumDistOnPath(coords, p);
  const here = pointAtDistOnPath(coords, traveled);
  const ahead = pointAtDistOnPath(coords, traveled + lookaheadM);
  const forward = here[0] !== ahead[0] || here[1] !== ahead[1];
  const [a, b] = forward
    ? [here, ahead]
    : [pointAtDistOnPath(coords, Math.max(0, traveled - lookaheadM)), here];
  if (a[0] === b[0] && a[1] === b[1]) return null;
  return bearing({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
}
