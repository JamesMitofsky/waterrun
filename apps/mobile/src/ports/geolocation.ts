import * as Location from "expo-location";
import type { GeoPoint, GeolocationPort } from "@water-run/core/ports";

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
