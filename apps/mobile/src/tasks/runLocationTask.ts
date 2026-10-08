import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import type { GeoPoint, GeoWatch } from "@rosm/core/ports";
import { getActiveRunId, trackingAction } from "@rosm/core/runLifecycle";
import { emitPoint, listenerCount, onPoint } from "../ports/locationEmitter";

// Live run tracking: the background location task, and when it may run.
//
// A started task outlives the process: expo-task-manager persists it and
// restores it at the next launch (EXTaskService _restoreTasks on iOS,
// TaskService.restoreTasks on Android), and on iOS that resumes GPS at once.
// So stopping only when the run screen unmounts isn't enough: after a crash or
// a kill mid-run, the next launches would track at full accuracy with nothing
// listening. The task therefore runs only while both hold: a run is active
// (core's runLifecycle keeps its id in kv until the run ends) and a run screen
// is listening for fixes. reconcileRunTracking brings the task in line with
// that. Every start and stop goes through it, one at a time, each reading the
// facts on its own turn, so a quick unmount and remount can't stop the task
// the new screen relies on.
export const RUN_LOCATION_TASK = "rosm-run-location";

// Registered at module scope (imported from app/_layout) so it exists at launch,
// including cold background deliveries. The body touches no React — it pushes
// each location into the shared emitter.
TaskManager.defineTask(RUN_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  // Fixes nobody will use: the task outlived its run or its screen (restored
  // after the app died mid-run). Stop it rather than track for nobody.
  if (getActiveRunId() === null || listenerCount() === 0) {
    void reconcileRunTracking();
    return;
  }
  const { locations } = data as { locations: Location.LocationObject[] };
  for (const loc of locations) {
    const h = loc.coords.heading;
    emitPoint({
      lat: loc.coords.latitude,
      lon: loc.coords.longitude,
      // heading is course-over-ground: -1 / null when stationary.
      heading: h != null && Number.isFinite(h) && h >= 0 ? h : null,
      accuracy: loc.coords.accuracy ?? undefined,
    });
  }
});

let turn: Promise<void> = Promise.resolve();

// Start or stop the task to match the facts above, after any start or stop
// already under way. `onError` hears why a start failed.
export function reconcileRunTracking(onError?: (msg: string) => void): Promise<void> {
  const next = turn.then(() => reconcile(onError));
  turn = next.catch(() => {});
  return next;
}

async function reconcile(onError?: (msg: string) => void): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK).catch(
    () => null,
  );
  const action = trackingAction({
    activeRun: getActiveRunId() !== null,
    listening: listenerCount() > 0,
    started,
  });
  if (action === "stop") {
    // Rejects when the task isn't registered, i.e. already stopped.
    await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK).catch(() => {});
  } else if (action === "start") {
    await start(onError);
  }
}

async function start(onError?: (msg: string) => void): Promise<void> {
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) {
      onError?.("Location permission is required to guide your run.");
      return;
    }
    // Best-effort: without "Always" the run still tracks foreground + while the
    // screen is on (kept awake), which is the v1 experience.
    await Location.requestBackgroundPermissionsAsync().catch(() => {});
    await Location.startLocationUpdatesAsync(RUN_LOCATION_TASK, {
      // Highest, not BestForNavigation: expo-location maps that to iOS's
      // kCLLocationAccuracyBestForNavigation, which Apple means for a device
      // on power, and to a 500 ms fused interval on Android. Highest is
      // kCLLocationAccuracyBest and 1 s; distanceInterval replaces its 25 m
      // Android default.
      accuracy: Location.Accuracy.Highest,
      distanceInterval: 5,
      activityType: Location.ActivityType.Fitness,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "Tracking your run",
        notificationBody: "Water Run is recording your route and the points you survey.",
      },
    });
  } catch (e) {
    onError?.((e as Error).message);
  }
}

// Stream the active run's fixes to `onP`, starting the task if it isn't
// running. The listener is in place before the task can start, so its first
// fix has somewhere to go. clear() stops listening, and the task stops with
// the last listener; ending the run stops it even while the screen is up.
export function trackRun(onP: (p: GeoPoint) => void, onError: (msg: string) => void): GeoWatch {
  const off = onPoint(onP);
  void reconcileRunTracking(onError);
  return {
    clear: () => {
      off();
      void reconcileRunTracking();
    },
  };
}
