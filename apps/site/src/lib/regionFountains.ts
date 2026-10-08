import type { Fountain } from "@rosm/core/schemas";
import { apiErrorMessage, readApiJson, type ApiReply } from "@rosm/core/apiResponse";
import { apiFetch, ApiTimeoutError } from "@/lib/api";

/**
 * The fixed areas `GET /api/fountains` serves, by name. One box per name, so
 * the reply is the same for every visitor and the CDN can hold it — where a
 * query for the visitor's own viewport would be a fresh Overpass search on
 * every visit.
 */
export type FountainRegion = "dc";

const TOOK_TOO_LONG = "The fountain search took too long to respond. Please try again.";
const OFFLINE = "You appear to be offline. Check your connection and try again.";
const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";
const OSM_BUSY = "OpenStreetMap is busy — try again in a moment.";
const GENERIC = "Couldn't load fountains. Please try again.";

/** A reply that came back without fountains. Its message is written for the visitor. */
export class FountainLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FountainLoadError";
  }
}

function failedReplyMessage(reply: Extract<ApiReply<unknown>, { ok: false }>): string {
  // The endpoint's own words, when it sent any: they are written for this
  // card, and only the server knows the real reason (rate limited, timed out
  // upstream).
  const own = apiErrorMessage(reply.body);
  if (own) return own;
  // A success status on a body that isn't JSON: something between here and
  // the server answered instead (a captive portal, a proxy), and
  // `readApiJson` has already said so in words.
  if (reply.status < 400) return reply.message;
  // What is left is the platform's own error page, worth its status alone.
  if (reply.status === 503 && reply.retryable) return OSM_BUSY;
  if (reply.status === 504) return TOOK_TOO_LONG;
  return `Couldn't load fountains (status ${reply.status}).`;
}

/**
 * Every drinking-water point in `region`. Throws `FountainLoadError` for a
 * reply that carries none, and passes `apiFetch`'s own rejections (offline,
 * `ApiTimeoutError`) through untouched — `fountainLoadErrorMessage` words
 * either.
 */
export async function fetchRegionFountains(
  region: FountainRegion,
  { timeoutMs }: { timeoutMs: number },
): Promise<Fountain[]> {
  const r = await apiFetch(`/api/fountains?region=${region}`, {}, { timeoutMs });
  const reply = await readApiJson<{ fountains?: unknown } | null>(r);
  if (!reply.ok) throw new FountainLoadError(failedReplyMessage(reply));
  const found = reply.data?.fountains;
  if (!Array.isArray(found)) throw new FountainLoadError(GENERIC);
  return found as Fountain[];
}

/**
 * The line the error card shows for a failed `fetchRegionFountains`.
 *
 * Never an error's own text unless it is ours. fetch() words a network
 * failure per browser — "Load failed", "Failed to fetch", "NetworkError when
 * attempting to fetch resource." — and none of it is written for a visitor.
 */
export function fountainLoadErrorMessage(
  e: unknown,
  online = typeof navigator === "undefined" || navigator.onLine !== false,
): string {
  if (e instanceof FountainLoadError) return e.message;
  if (e instanceof ApiTimeoutError) return TOOK_TOO_LONG;
  if (!online) return OFFLINE;
  // fetch() rejects with a TypeError whenever no response arrived at all.
  if (e instanceof TypeError) return UNREACHABLE;
  return GENERIC;
}
