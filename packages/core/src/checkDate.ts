// OSM survey/check-date tag helpers. Client-safe (no server deps) so both the
// Overpass fetch path and browser-side filters can share the same logic.
import type { RecencyMode } from "./schemas";

// OSM tags surveyors use to record when a point was last verified on the ground.
export const CHECK_DATE_KEYS = ["check_date", "survey:date", "checked"];

// Parse an OSM date tag (YYYY, YYYY-MM, or YYYY-MM-DD) to a UTC epoch ms, or
// null if missing/unparseable. Partial dates resolve to their earliest instant.
export function parseCheckDate(raw?: string): number | null {
  if (!raw) return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) : 1;
  const day = m[3] ? Number(m[3]) : 1;
  const t = Date.UTC(year, month - 1, day);
  // Date.UTC silently rolls an out-of-range month or day forward (2024-13-45
  // becomes 2025-02-14), which would turn a typo into a later, plausible check.
  // A real date reads back unchanged.
  const d = new Date(t);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return t;
}

// Epoch ms of a point's most recent ground verification, or null if never recorded.
// Surveyors use different keys, so a node can carry an old check_date next to a
// newer survey:date, or a value that isn't a date at all: take the latest one
// that parses.
export function lastCheckedMs(tags: Record<string, string>): number | null {
  let latest: number | null = null;
  for (const key of CHECK_DATE_KEYS) {
    const t = parseCheckDate(tags[key]);
    if (t !== null && (latest === null || t > latest)) latest = t;
  }
  return latest;
}

// How `checkedAgoLabel` writes its units: "short" is the compact form for a
// tight popup ("Checked 3w ago"); "long" spells them out for copy that is
// read rather than scanned ("Checked 3 weeks ago").
export type AgoStyle = "short" | "long";

// "Checked … ago" label from the most recent survey date, or "Never checked"
// when none is recorded. Days under a week, then weeks, months, years — each
// floored, so a point checked 13 days ago was checked "1 week ago", not two.
// `now` is passed in so the caller owns the clock (testable, no hidden
// Date.now()).
export function checkedAgoLabel(
  tags: Record<string, string>,
  now: number,
  style: AgoStyle = "short",
): string {
  const ms = lastCheckedMs(tags);
  if (ms === null) return "Never checked";
  const days = Math.max(0, Math.floor((now - ms) / 86_400_000));
  if (days === 0) return "Checked today";
  const unit = (n: number, short: string, long: string) =>
    style === "long" ? `Checked ${n} ${long}${n === 1 ? "" : "s"} ago` : `Checked ${n}${short} ago`;
  if (days < 7) return unit(days, "d", "day");
  if (days < 30) return unit(Math.floor(days / 7), "w", "week");
  // Bounded by days, not by the month count: day 360 through 364 floor to
  // twelve months but are not yet a year.
  if (days < 365) return unit(Math.floor(days / 30), "mo", "month");
  return unit(Math.floor(days / 365), "y", "year");
}

// True if a point passes the recency filter. "stale" keeps points last surveyed
// before the cutoff OR never surveyed (the ones worth verifying); "fresh" keeps
// only points surveyed on/after the cutoff; "any" keeps everything.
export function matchesRecency(
  tags: Record<string, string>,
  mode: RecencyMode,
  cutoffMs: number,
): boolean {
  if (mode === "any") return true;
  const checked = lastCheckedMs(tags);
  if (mode === "stale") return checked === null || checked < cutoffMs;
  return checked !== null && checked >= cutoffMs;
}
