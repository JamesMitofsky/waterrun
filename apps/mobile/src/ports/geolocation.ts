import * as Location from "expo-location";
import type { GeoPoint, GeoWatch, GeolocationPort } from "@rosm/core/ports";
import { onPoint, listenerCount } from "./locationEmitter";
import { RUN_LOCATION_TASK } from "../tasks/runLocationTask";

function toPoint(c: Location.LocationObjectCoords): GeoPoint {
  const h = c.heading;
  return {
    lat: c.latitude,
    lon: c.longitude,
    heading: h != null && Number.isFinite(h) && h >= 0 ? h : null,
    accuracy: c.accuracy ?? undefined,
  };
}

// Core only needs the one-shot fix (planner "use my location").
export const geolocation: GeolocationPort = {
  getCurrentPosition: async () => {
    await Location.requestForegroundPermissionsAsync();
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return toPoint(pos.coords);
  },
};

// Instant, possibly-stale fix for immediate map feedback — no permission prompt,
// no GPS wait. Null when permission isn't granted yet or nothing is cached; the
// caller follows up with the accurate one-shot above.
export async function getLastKnownPosition(): Promise<GeoPoint | null> {
  const granted = await Location.getForegroundPermissionsAsync()
    .then((r) => r.granted)
    .catch(() => false);
  if (!granted) return null;
  const pos = await Location.getLastKnownPositionAsync().catch(() => null);
  return pos ? toPoint(pos.coords) : null;
}

// Live run tracking (foreground + background). Starts the TaskManager location task
// so the run keeps recording with the screen locked, and streams its points to the
// caller via the shared emitter. Not a core port — the run hook calls it directly.
export async function watchRunPosition(
  onP: (p: GeoPoint) => void,
  onError: (msg: string) => void,
): Promise<GeoWatch> {
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (!fg.granted) {
      onError("Location permission is required to guide your run.");
      return { clear: () => {} };
    }
    // Best-effort: without "Always" the run still tracks foreground + while the
    // screen is on (kept awake), which is the v1 experience.
    await Location.requestBackgroundPermissionsAsync().catch(() => {});

    const already = await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK).catch(
      () => false,
    );
    if (!already) {
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
    }
  } catch (e) {
    onError((e as Error).message);
  }

  const off = onPoint(onP);
  return {
    clear: () => {
      off();
      if (listenerCount() === 0) {
        Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK).catch(() => {});
      }
    },
  };
}
