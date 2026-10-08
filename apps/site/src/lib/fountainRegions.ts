// Fixed coverage areas for the public fountain map's cacheable GET.
//
// The public map has a fixed subject, so it asks for a fixed region rather than
// whatever the device's camera shows. That keeps the request identical for every
// visitor, which is what lets the CDN answer it, and keeps it under the search
// cap: a phone opens zoomed far out to show the whole region, and its viewport
// alone is several times larger than any query we allow.
import { MAP_FRAMES, TILE_SIZE, projectMercator, unprojectMercator } from "./basemap/frames";
import type { MapFrameVariant } from "./basemap/frames";

// [south, west, north, east], the order Overpass and FountainsRequest use.
export type RegionBounds = [number, number, number, number];

// The ground a frame variant shows at its opening zoom, rounded outward to five
// decimals (about a metre) so the box never shrinks and the query text is stable.
export function frameBounds({ center, zoom, frame }: MapFrameVariant): RegionBounds {
  const world = TILE_SIZE * 2 ** zoom;
  const [x, y] = projectMercator(center[1], center[0]);
  const dx = frame.width / 2 / world;
  const dy = frame.height / 2 / world;
  const [west, north] = unprojectMercator(x - dx, y - dy);
  const [east, south] = unprojectMercator(x + dx, y + dy);
  const down = (n: number) => Math.floor(n * 1e5) / 1e5;
  const up = (n: number) => Math.ceil(n * 1e5) / 1e5;
  return [down(south), down(west), up(north), up(east)];
}

// The desktop frame of the DC map: the ground the map opens on at its wide
// variant, about 46 x 26 km of the metro. The narrow variant is the same centre
// zoomed out to frame the region on a phone, far past the search cap, so it
// can't serve as the query box.
const dcWide = MAP_FRAMES["live-fountains-dc"].variants.find((v) => v.media === null);
if (!dcWide) throw new Error("live-fountains-dc has no wide variant");

const REGIONS = new Map<string, RegionBounds>([["dc", frameBounds(dcWide)]]);

// The bounds of a named region, or undefined for a name we don't serve.
export function regionBounds(name: string | null): RegionBounds | undefined {
  return name === null ? undefined : REGIONS.get(name);
}
