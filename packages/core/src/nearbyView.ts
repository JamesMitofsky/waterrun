// Where the Nearby map opens. It is drawn on the app's very first frame, long
// before a location fix can arrive, so it opens on the spot the user last
// searched from and the fix then moves it, often only a little. The spot is
// kept in the device's key/value store, which reads synchronously, so even
// the first frame has it.
//
// Only a search made from a location fix moves it. The opening view stands in
// for the user's position while GPS resolves, and an area browsed to with
// "Search this area" can be anywhere.
import type { Pt } from "./geo";
import type { KvPort } from "./ports";
import { corePorts } from "./configure";

const CENTER_KEY = "water-run:nearby:center";

// The kv port, or null where core isn't configured: like the route archive,
// this is best-effort and must never throw into the screen.
function store(): KvPort | null {
  try {
    return corePorts().kv;
  } catch {
    return null;
  }
}

// Whatever is under the key is only trusted as a place on the globe: it may
// be half-written, or left by another build. The range checks also turn away
// NaN and Infinity (a stored 1e999 parses as Infinity).
function isPlace(v: unknown): v is Pt {
  if (typeof v !== "object" || v === null) return false;
  const { lat, lon } = v as Record<string, unknown>;
  return (
    typeof lat === "number" &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lon === "number" &&
    lon >= -180 &&
    lon <= 180
  );
}

// The spot the last search from a fix was made, or null when there is none to
// trust (first launch, or storage unreadable).
export function loadNearbyCenter(): Pt | null {
  const kv = store();
  if (!kv) return null;
  try {
    const raw = kv.get(CENTER_KEY);
    if (raw == null) return null;
    const v: unknown = JSON.parse(raw);
    return isPlace(v) ? { lat: v.lat, lon: v.lon } : null;
  } catch {
    return null;
  }
}

// Remember `p` as where the Nearby map opens next. Only the coordinates are
// kept: a fix can carry a heading and an accuracy too.
export function saveNearbyCenter(p: Pt): void {
  const kv = store();
  if (!kv) return;
  try {
    kv.set(CENTER_KEY, JSON.stringify({ lat: p.lat, lon: p.lon }));
  } catch {
    // storage full or disabled — the next launch opens on an older spot, or
    // on the world
  }
}
