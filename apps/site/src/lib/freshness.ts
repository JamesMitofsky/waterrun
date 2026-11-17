import { lastCheckedMs } from "@water-run/core/checkDate";
import { isOutOfService } from "@water-run/core/fountainFilters";
import type { MarkerGlyph } from "@/lib/markerGlyph";

// What the map says about a fountain, from its last on-the-ground check:
//   fresh          — checked within a year, and working
//   out_of_service — checked within a year, and not working
//   stale          — not checked in over a year (or ever), so whatever the tags
//                    say may no longer hold; the point that most needs a visit.
//                    An out-of-service point lands here too once its check is
//                    that old: it may have been repaired since.
export type Bucket = "fresh" | "stale" | "out_of_service";

export const BUCKET_COLOR: Record<Bucket, string> = {
  fresh: "#10b981", // emerald
  stale: "#f59e0b", // amber
  out_of_service: "#f43f5e", // rose
};

export const BUCKET_LABEL: Record<Bucket, string> = {
  fresh: "<1y",
  stale: ">1y",
  out_of_service: "Out of service, <1y",
};

// The mark drawn over a bucket's dots, so the states are told apart by more
// than colour. Fresh dots stay plain.
export const BUCKET_GLYPH: Record<Bucket, MarkerGlyph | undefined> = {
  fresh: undefined,
  stale: "question",
  out_of_service: "x",
};

export const BUCKET_ORDER = ["fresh", "stale", "out_of_service"] as const;

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const FRESH_CUTOFF = 12 * MONTH_MS; // checked within a year

// Grade a point by how long ago it was last verified and what was found.
// `nowMs` is passed in so the caller owns the clock (pure across re-renders /
// testable).
export function bucketOf(tags: Record<string, string>, nowMs: number): Bucket {
  const checked = lastCheckedMs(tags);
  if (checked == null || nowMs - checked > FRESH_CUTOFF) return "stale";
  return isOutOfService(tags) ? "out_of_service" : "fresh";
}
