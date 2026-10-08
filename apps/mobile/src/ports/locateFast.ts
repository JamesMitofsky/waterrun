import * as Location from "expo-location";
import type { Pt } from "@water-run/core/geo";
import { locateFast as locateWith, type Fix } from "@water-run/core/locate";
import { geolocation } from "./geolocation";

// How old and how rough a cached fix may be and still center a map. Ten
// minutes keeps it to roughly where the phone is now; 200 m is well inside
// the area a first search covers, so the fresh fix rarely has to redo it.
const RECENT_MAX_AGE_MS = 10 * 60_000;
const RECENT_MAX_ACCURACY_M = 200;

// The OS's last fix when it is recent and accurate enough to show at once:
// no permission prompt and no GPS wait. Null when location isn't permitted
// yet, or nothing usable is cached (expo-location applies maxAge and
// requiredAccuracy natively and resolves null).
export async function recentFix(): Promise<Pt | null> {
  const granted = await Location.getForegroundPermissionsAsync()
    .then((r) => r.granted)
    .catch(() => false);
  if (!granted) return null;
  const pos = await Location.getLastKnownPositionAsync({
    maxAge: RECENT_MAX_AGE_MS,
    requiredAccuracy: RECENT_MAX_ACCURACY_M,
  }).catch(() => null);
  return pos ? { lat: pos.coords.latitude, lon: pos.coords.longitude } : null;
}

// The recent fix right away (if there is one), then a fresh GPS fix; see
// core's locateFast for what is reported when. Returns a cancel function.
export function locateFast(onFix: (fix: Fix) => void, onError: (e: unknown) => void): () => void {
  return locateWith(
    { recent: recentFix, current: () => geolocation.getCurrentPosition() },
    onFix,
    onError,
  );
}
