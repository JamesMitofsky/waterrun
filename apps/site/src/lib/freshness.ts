import { lastCheckedMs } from "@water-run/core/checkDate";
import { isOutOfService } from "@water-run/core/fountainFilters";

// Freshness of a fountain's last on-the-ground verification. Never-checked folds
// into "stale" — the point that most needs a runner to visit.
export type Bucket = "fresh" | "stale";

export const BUCKET_COLOR: Record<Bucket, string> = {
  fresh: "#10b981", // emerald
  stale: "#f59e0b", // amber
};

export const BUCKET_LABEL: Record<Bucket, string> = {
  fresh: "<1y",
  stale: ">1y",
};

export const BUCKET_ORDER = ["fresh", "stale"] as const;

// An out-of-service point confirmed within the last year is settled, not
// actionable, so the map grays it out instead of painting it green. The color
// matches the one MapView gives a `dimmed` marker.
export const RETIRED_COLOR = "#9ca3af"; // gray
export const RETIRED_LABEL = "Out of service, <1y";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const FRESH_CUTOFF = 12 * MONTH_MS; // checked within a year

// Grade a point by how long ago it was last verified. `nowMs` is passed in so
// the caller owns the clock (pure across re-renders / testable).
export function bucketOf(tags: Record<string, string>, nowMs: number): Bucket {
  const checked = lastCheckedMs(tags);
  if (checked == null) return "stale";
  return nowMs - checked <= FRESH_CUTOFF ? "fresh" : "stale";
}

// True for the gray dots: out of service, and confirmed so within the last
// year. An out-of-service point checked longer ago than that stays amber — it
// may have been repaired since, so it still wants a visit.
export function isRetired(tags: Record<string, string>, nowMs: number): boolean {
  return isOutOfService(tags) && bucketOf(tags, nowMs) === "fresh";
}
