// Fetch OSM points from the Overpass API.
import type { Fountain } from "@water-run/core/schemas";
import type { TagFilter, RecencyMode } from "@water-run/core/schemas";
import { matchesRecency } from "@water-run/core/checkDate";
import { UpstreamNetworkError, UpstreamTimeoutError, upstreamFetch } from "./upstream";

export { parseCheckDate, matchesRecency } from "@water-run/core/checkDate";

// Cutoff epoch ms for "N months ago" from now.
function monthsAgo(months: number): number {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

// Public Overpass mirrors, all serving identical ODbL OSM data. Tried in order;
// when one is overloaded or unreachable we fall through to the next. An env
// override is prepended so a self-hosted instance takes priority.
const OVERPASS_ENDPOINTS = [
  process.env.OVERPASS_URL,
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
].filter((u): u is string => !!u);

// The query's own [timeout] hint, in seconds. Overpass admits a query only when
// it has room for its declared budget, so a modest one gets a slot sooner on a
// busy server, and a mirror that can't finish in time says so (a runtime-error
// remark) early enough to leave room for the next mirror.
const QUERY_TIMEOUT_S = 15;
// Per-attempt client limit, unless the caller sets its own: past the server's
// own budget, so a busy mirror gets to answer or report its timeout before we
// give up on it.
const ATTEMPT_TIMEOUT_MS = (QUERY_TIMEOUT_S + 5) * 1000;
// Total budget across every mirror and retry, unless the caller sets its own.
const DEFAULT_DEADLINE_MS = 25_000;
// Only a 5xx is retried on the same mirror, once, after this pause.
const MAX_ATTEMPTS_PER_ENDPOINT = 2;
const RETRY_PAUSE_MS = 500;

// Error thrown when every Overpass endpoint/attempt is exhausted. Carries a
// short, already-cleaned message (never raw HTML) plus a retryable hint so the
// API route and UI can offer a sensible recovery path. `timedOut` marks a
// failure where the last mirror tried, or the overall deadline, ran out of time.
export class OverpassError extends Error {
  status: number | null;
  retryable: boolean;
  timedOut: boolean;
  constructor(
    message: string,
    status: number | null,
    retryable: boolean,
    { timedOut = false }: { timedOut?: boolean } = {},
  ) {
    super(message);
    this.name = "OverpassError";
    this.status = status;
    this.retryable = retryable;
    this.timedOut = timedOut;
  }
}

const BUSY_MESSAGE = "OpenStreetMap's data server is busy right now. Please try again in a moment.";

// Turn an Overpass error body (often a full XHTML doc) into a short human line.
function cleanErrorBody(status: number, body: string): string {
  const lower = body.toLowerCase();
  if (status === 429 || lower.includes("too many requests")) {
    return "OpenStreetMap's data server is rate limiting requests. Please wait a moment and try again.";
  }
  if (lower.includes("too busy") || lower.includes("timeout") || status === 504) {
    return BUSY_MESSAGE;
  }
  return `OpenStreetMap's data server returned an error (${status}). Please try again shortly.`;
}

const tooSlow = () =>
  new OverpassError(
    "OpenStreetMap's data server took too long to respond. Please try again.",
    null,
    true,
    { timedOut: true },
  );

const unreachable = () =>
  new OverpassError(
    "Couldn't reach OpenStreetMap's data server. Check your connection and try again.",
    null,
    true,
  );

// With [out:json], Overpass has already sent "200 OK" by the time a query runs
// out of time or memory, so it reports that inside the body as a remark next to
// an empty or partial `elements`. Taking that as the answer would show an empty
// map as if there were no fountains.
function isRuntimeError(remark: unknown): boolean {
  return typeof remark === "string" && /runtime error|timed out|out of memory/i.test(remark);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchOverpassOptions = {
  // The caller's cancellation, usually the incoming request's signal: once the
  // client has gone, no further mirror is tried.
  signal?: AbortSignal;
  // Total time budget across every mirror and retry.
  deadlineMs?: number;
  // The most one attempt may take. A caller with a short deadline keeps this
  // under half of it, so a mirror that hangs still leaves the next one a turn.
  attemptTimeoutMs?: number;
};

// Fetch an Overpass query within a deadline, falling back across mirrors.
// Returns the parsed JSON; throws OverpassError when the mirrors or the time
// run out, or the caller's abort reason when it cancels. A mirror that answers
// 429 (no free slot for our IP), hangs or can't be reached is left for the next
// one straight away: asking it again moments later is exactly what the
// operators ask clients not to do, and a hung mirror rarely recovers in seconds.
export async function fetchOverpass(
  query: string,
  {
    signal,
    deadlineMs = DEFAULT_DEADLINE_MS,
    attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  }: FetchOverpassOptions = {},
): Promise<{ elements: OverpassEl[] }> {
  const deadline = Date.now() + deadlineMs;
  let lastError: OverpassError | null = null;

  mirrors: for (const url of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ENDPOINT; attempt++) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break mirrors;

      let res: Response;
      try {
        res = await upstreamFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ data: query }).toString(),
          timeoutMs: Math.min(remaining, attemptTimeoutMs),
          signal,
        });
      } catch (e) {
        if (e instanceof UpstreamTimeoutError) lastError = tooSlow();
        else if (e instanceof UpstreamNetworkError) lastError = unreachable();
        else throw e; // the caller cancelled
        continue mirrors;
      }

      if (res.ok) {
        const json = (await res.json().catch(() => null)) as {
          elements?: OverpassEl[];
          remark?: unknown;
        } | null;
        if (json && Array.isArray(json.elements) && !isRuntimeError(json.remark)) {
          return { elements: json.elements };
        }
        lastError = new OverpassError(BUSY_MESSAGE, null, true);
        continue mirrors;
      }

      // 429 and 5xx are transient server-side conditions; anything else means
      // the query itself was refused, which no mirror will answer differently.
      const retryable = res.status === 429 || res.status >= 500;
      lastError = new OverpassError(
        cleanErrorBody(res.status, await res.text()),
        res.status,
        retryable,
      );
      if (!retryable) throw lastError;
      if (res.status === 429 || attempt === MAX_ATTEMPTS_PER_ENDPOINT) continue mirrors;
      await sleep(Math.min(RETRY_PAUSE_MS, Math.max(0, deadline - Date.now())));
    }
  }

  throw lastError ?? tooSlow();
}

export type OverpassEl = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

// The area a search covers: either a circle (`around` an anchor) or the exact
// viewport rectangle (`bounds`). A rectangle query returns only points inside
// the drawn box — a circle circumscribing the viewport would spill past its
// edges — so viewport ("Search this area") searches use bounds, while anchored
// GPS/pin searches stay circular.
export type SearchRegion =
  { lat: number; lon: number; radiusM: number } | { bounds: [number, number, number, number] }; // [south, west, north, east]

// Overpass area filter for a region: `(around:r,lat,lon)` or a `(s,w,n,e)` bbox.
function areaFilter(region: SearchRegion): string {
  if ("bounds" in region) {
    const [s, w, n, e] = region.bounds;
    return `(${s},${w},${n},${e})`;
  }
  return `(around:${Math.round(region.radiusM)},${region.lat},${region.lon})`;
}

// A value as an Overpass QL string literal. The tag reaches us from the request
// body, so without escaping a `"` would end the literal and let the rest of the
// value rewrite the query. QL takes C-style escapes inside quotes; control
// characters have no business in an OSM tag and are refused outright.
export function qlString(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F]/.test(s)) throw new Error("Control characters aren't allowed in a tag");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Build a query for nodes/ways/relations matching key=value within a region.
// With `includeDisused`, also match the `disused:key` lifecycle variant so
// out-of-order points come back too; the prefix is preserved in each element's
// tags for client-side classification. `abandoned:` (removed) is deliberately
// left out — removed points are never surfaced, so we don't fetch them.
export function buildQuery(region: SearchRegion, tag: TagFilter, includeDisused = false): string {
  const area = areaFilter(region);
  const prefixes = includeDisused ? ["", "disused:"] : [""];
  const stmts = prefixes
    .flatMap((prefix) => {
      const sel = `[${qlString(prefix + tag.key)}=${qlString(tag.value)}]`;
      return [`node${sel}${area};`, `way${sel}${area};`, `relation${sel}${area};`];
    })
    .map((s) => `  ${s}`)
    .join("\n");
  return `[out:json][timeout:${QUERY_TIMEOUT_S}];
(
${stmts}
);
out center tags;`;
}

export async function fetchFountains(
  region: SearchRegion,
  tag: TagFilter,
  recencyMode: RecencyMode = "any",
  recencyMonths = 6,
  includeDisused = false,
  options: FetchOverpassOptions = {},
): Promise<Fountain[]> {
  const query = buildQuery(region, tag, includeDisused);
  const cutoffMs = monthsAgo(recencyMonths);
  const json = await fetchOverpass(query, options);
  return json.elements
    .map((el): Fountain | null => {
      const lt = el.lat ?? el.center?.lat;
      const ln = el.lon ?? el.center?.lon;
      if (lt == null || ln == null) return null;
      return { id: el.id, lat: lt, lon: ln, tags: el.tags ?? {} };
    })
    .filter((f): f is Fountain => f !== null)
    .filter((f) => matchesRecency(f.tags, recencyMode, cutoffMs));
}
