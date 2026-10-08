// A run's life outside any one screen: which run is active, keeping its archive
// current, when location tracking should run for it, and how it ends. The run
// store and the planner's "run" phase live in memory only, so whatever must
// outlast the process (or a screen) is decided here.
import type { KvPort } from "./ports";
import { corePorts } from "./configure";
import { callApi, postJson } from "./apiCall";
import { archiveRoute } from "./routeArchive";
import { useRun } from "./stores/run";
import { usePlanner } from "./stores/planner";
import { useOutbox } from "./stores/outbox";

// The routeId of the run the user started and hasn't ended. Kept in the kv
// store so it outlives the process: location tracking runs only for an active
// run, so tracking the OS restores after the app died mid-run can tell it has
// nobody to track for.
const ACTIVE_RUN_KEY = "rosm:active-run";

// How long an ended run waits for the outbox to settle before giving up on
// closing its changeset: the last edit's undo hold, then a send or two.
const CLOSE_SETTLE_MS = 2 * 60_000;
const CLOSE_TIMEOUT_MS = 30_000;

// The kv port, or null where core isn't configured (a background launch that
// never ran the app's setup): every reader here is best-effort, and one that
// can't read the key treats the run as over.
function store(): KvPort | null {
  try {
    return corePorts().kv;
  } catch {
    return null;
  }
}

export function getActiveRunId(): string | null {
  try {
    return store()?.get(ACTIVE_RUN_KEY) || null;
  } catch {
    return null;
  }
}

function setActiveRunId(routeId: string | null): void {
  try {
    if (routeId) store()?.set(ACTIVE_RUN_KEY, routeId);
    else store()?.remove(ACTIVE_RUN_KEY);
  } catch {
    // Storage unavailable: then tracking stops with the run screen, as before.
  }
}

// Write the run in progress to the archive, at `index` (the stop it's moving
// to). In place: the routeId keys the entry.
export function archiveRun(index = useRun.getState().index): void {
  const s = useRun.getState();
  if (!s.hasPlan || !s.routeId) return;
  archiveRoute({
    routeId: s.routeId,
    plan: {
      start: s.start,
      loop: s.loop,
      tagKey: s.tagKey,
      tagValue: s.tagValue,
      stops: s.stops,
      vias: s.vias,
      pool: s.pool,
      added: s.added,
      routeCoords: s.routeCoords,
      distanceM: s.distanceM,
      turns: s.turns,
      index,
      changesetId: s.changesetId,
    },
    edits: useOutbox.getState().items,
  });
}

// The run on screen is under way: mark it active.
export function beginRun(): void {
  const { hasPlan, routeId } = useRun.getState();
  if (!hasPlan || !routeId) return;
  if (getActiveRunId() !== routeId) setActiveRunId(routeId);
}

// What location tracking should do now. It belongs to an active run with a
// screen listening for its fixes; anything else is tracking for nobody.
// `started` is null when the platform couldn't say: then act on what's wanted.
export function trackingAction(f: {
  activeRun: boolean;
  listening: boolean;
  started: boolean | null;
}): "start" | "stop" | null {
  if (f.activeRun && f.listening) return f.started === true ? null : "start";
  return f.started === false ? null : "stop";
}

// End the current run, however it ends (finished, ended early, ended from the
// planner). Synchronous, so the caller can leave the moment it returns: the run
// is archived as finished, no longer active, the run and planner stores are
// back to idle, and edits OSM already has are dropped from the outbox. Unsent
// edits stay queued: they're the survey, not the run. Returns the run's
// routeId, or null if there was no run.
export function endRun(): string | null {
  const { hasPlan, routeId, index, stops } = useRun.getState();
  if (hasPlan) archiveRun(Math.max(index, stops.length));
  setActiveRunId(null);
  useRun.getState().reset();
  usePlanner.getState().resetAfterRun();
  useOutbox
    .getState()
    .pruneSent()
    .catch(() => {});
  return hasPlan && routeId ? routeId : null;
}

export type CloseOutcome = "closed" | "unsettled" | "superseded" | "none-open" | "failed";

// Close the changeset an ended run's edits went into, once they're all in it.
// Meant to run in the background after endRun: the run's last edit is usually
// still in its undo hold, and closing first would send it into a fresh
// changeset that nothing ever closes. Best-effort throughout: OSM closes an
// idle changeset by itself within the hour, so giving up costs nothing.
//   unsettled  — edits were still waiting after `settleMs` (offline): left open
//   superseded — a new run started meanwhile; its edits share the changeset and
//                its own end closes it
//   none-open  — no edit opened a changeset
//   failed     — the close request failed: the id is kept, and the next edit
//                moves to a fresh changeset if OSM refuses it
export async function closeChangesetWhenSettled(settleMs = CLOSE_SETTLE_MS): Promise<CloseOutcome> {
  // Not awaited: a flush can take minutes; waitUntilSettled bounds the wait.
  useOutbox
    .getState()
    .flush({ force: true })
    .catch(() => {});
  if (!(await useOutbox.getState().waitUntilSettled(settleMs))) return "unsettled";
  if (useRun.getState().hasPlan) return "superseded";
  const changesetId = useOutbox.getState().changesetId;
  if (changesetId === undefined) return "none-open";
  const reply = await callApi<{ ok?: boolean }>(
    "/api/osm/close",
    postJson({ changesetId }),
    CLOSE_TIMEOUT_MS,
    "Couldn't close the changeset.",
  ).catch(() => null);
  // The server also answers ok for a changeset OSM had already closed.
  if (!reply?.ok || reply.data?.ok !== true) return "failed";
  // An edit sent meanwhile may have moved to a new changeset: keep that one.
  if (useOutbox.getState().changesetId === changesetId) {
    useOutbox.getState().setChangeset(undefined);
  }
  return "closed";
}
