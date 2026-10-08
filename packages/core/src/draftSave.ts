// When the planner's route is saved as the draft a relaunch offers to resume.
// resumeDraft restores a draft as a finished route (routeStale false, Start
// run ready), so a draft is only worth writing when its stops and line belong
// to its picks.
import type { Draft } from "./stores/planner";

// "save": snapshot the route on hand. "hold": write nothing new, but let a
// save already waiting go out. "drop": write nothing, and forget a save still
// waiting.
export type DraftSaveAction = "save" | "hold" | "drop";

export function draftSaveAction(s: {
  draftReady: boolean;
  resumable: Draft | null;
  stops: readonly unknown[];
  routeStale: boolean;
}): DraftSaveAction {
  // Before the saved draft has been read, while it is on offer, or with no
  // route at all, there is nothing to save, and a save still waiting is no
  // longer the route.
  if (!s.draftReady || s.resumable || s.stops.length === 0) return "drop";
  // A stale route's picks have moved on, but its stops and line are still the
  // last route that planned, until the re-plan lands, or for good if it
  // fails. Saved, that mix would resume as current, with Start run ready on
  // stops the map shows as removed. The last route that planned stands
  // instead: it is consistent, and the re-planned one replaces it once it
  // lands.
  if (s.routeStale) return "hold";
  return "save";
}
