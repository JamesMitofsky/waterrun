// Single entry point for talking to the Water Run backend (the Astro `/api`
// endpoints). The site and its API share an origin, so the base is empty and the
// httpOnly OSM cookie carries auth automatically.
import { ApiTimeoutError } from "@rosm/core/apiResponse";

// The shared class, not a copy: the mobile app's adapter throws the same one, so
// an `instanceof` check (or core's `isTransportError`) reads a timeout the same
// way whichever app made the request.
export { ApiTimeoutError };

// Trailing slash stripped so `${API_BASE}${path}` never double-slashes.
const API_BASE = (import.meta.env.PUBLIC_API_BASE ?? "").replace(/\/$/, "");

// Resolve an `/api/...` path to an absolute URL. Absolute URLs (e.g. third-party
// APIs) pass through untouched.
export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path}`;
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  // A hard client-side ceiling. The backend can retry upstream services (e.g.
  // Overpass across mirrors) for far longer than a user should wait, so callers
  // cap the total wait here; on expiry the request aborts and throws
  // ApiTimeoutError. Omit to wait indefinitely (previous behavior).
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<Response> {
  const base: RequestInit = {
    ...init,
    // Same-origin cookie auth on web.
    credentials: init.credentials ?? "include",
  };
  if (!timeoutMs) return fetch(apiUrl(path), base);

  const ctrl = new AbortController();
  const timedOut = { hit: false };
  const timer = setTimeout(() => {
    timedOut.hit = true;
    ctrl.abort();
  }, timeoutMs);
  // Honor a caller-supplied signal too: if it aborts, propagate to our fetch.
  if (init.signal) {
    if (init.signal.aborted) ctrl.abort();
    else init.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(apiUrl(path), { ...base, signal: ctrl.signal });
  } catch (e) {
    if (timedOut.hit) throw new ApiTimeoutError(timeoutMs);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
