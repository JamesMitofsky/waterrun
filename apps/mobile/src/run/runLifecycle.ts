import {
  closeChangesetWhenSettled,
  endRun as endRunState,
  forgetStaleActiveRun,
  reviveHeldUpdates,
} from "@water-run/core/runLifecycle";
import { reconcileRunTracking } from "../tasks/runLocationTask";
import { endRunProgress } from "../ports/runProgress";

// The one way a run ends on the phone, shared by Finish (also after "End route
// early") and the planner's End run. Nothing here waits on the network or on a
// screen unmounting: by the time it returns the run is archived as finished,
// tracking is stopping, its lock-screen progress (Live Activity or notification
// line) is going, the run and planner are back to idle and sent edits are
// tidied away, so the caller can leave at once. The run's own updates wait on
// the phone for its review (run-review), which sends them as one changeset; the
// outbox's changeset (edits made off a run) closes in the background once its
// edits have gone out. Returns the run's routeId, or null if there was no run.
export function endRun(): string | null {
  const routeId = endRunState();
  // The run is no longer active, so this stops the task even though the run
  // screen may still be listening.
  void reconcileRunTracking();
  endRunProgress();
  void closeChangesetWhenSettled();
  return routeId;
}

// Once per launch, before any screen: undo what a run the app didn't get to
// end left behind. A run that can't be resumed is no longer active, and its
// held updates go to review instead of being stranded; tracking
// the OS restored has nobody listening yet, so it stops; a Live Activity or
// progress line from before is taken down (a run that resumes starts a fresh
// one).
export function settleRunAtLaunch(): void {
  forgetStaleActiveRun();
  reviveHeldUpdates();
  void reconcileRunTracking();
  endRunProgress();
}
