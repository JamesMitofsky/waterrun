// A point's current state and when it was last verified, as the one line of
// copy the survey sheet shows over its buttons. Client-safe and zod-free:
// FountainStatus comes in as a type only, because fountainModel loads zod at
// runtime and the mobile bundle deliberately leaves zod out.
import { checkedAgoLabel, lastCheckedMs } from "./checkDate";
import { isOutOfService } from "./fountainFilters";
import type { FountainStatus } from "./fountainModel";

// What the tags can tell apart, and no more. A live primary tag is all a
// fountain marked partially working keeps (that survey only stamps the check
// date and a note), so "working" reads as in service: true of both, where
// "Working" would contradict the survey that found it broken.
const STATE_LABEL: Record<FountainStatus, string> = {
  working: "In service",
  out_of_order: "Out of order",
  removed: "Removed",
};

// The point's current state per its OSM lifecycle tags. Out of order is
// whatever isOutOfService says, the same test the map dot uses, so the sheet
// never disagrees with the dot just tapped on the same screen. abandoned:*
// counts as out of service there too, so it is checked first: a fountain
// that is gone is more than out of order.
export function pointStateOf(tags: Record<string, string>): FountainStatus {
  if (tags["abandoned:amenity"] != null) return "removed";
  if (isOutOfService(tags)) return "out_of_order";
  return "working";
}

// "Checked 3 weeks ago · In service". A point nobody has checked only carries the
// state it was mapped with, unverified, so its line says it is "Listed as"
// that rather than asserting it. `now` is passed in so the caller owns the
// clock, as with checkedAgoLabel.
export function pointStatusLine(tags: Record<string, string>, now: number): string {
  const ago = checkedAgoLabel(tags, now, "long");
  const state = STATE_LABEL[pointStateOf(tags)];
  if (lastCheckedMs(tags) === null) return `${ago} · Listed as ${state.toLowerCase()}`;
  return `${ago} · ${state}`;
}
