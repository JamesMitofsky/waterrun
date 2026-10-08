import type { APIRoute } from "astro";
import { z } from "zod";
import { FountainsRequest, type TagFilter } from "@rosm/core/schemas";
import { POINT_TYPES } from "@rosm/core/pointTypes";
import { fetchFountains, OverpassError } from "@/lib/overpass";
import { regionBounds } from "@/lib/fountainRegions";
import { readJsonBody } from "@/lib/requestBody";

export const prerender = false;

// What the public map shows: every drinking fountain, in service or not.
const PUBLIC_MAP_TAG = { key: "amenity", value: "drinking_water" };

// A region's answer is the same for every visitor and OSM data moves slowly, so
// the CDN serves it for an hour and keeps serving the previous copy for a day
// while it refreshes in the background: only a refresh, never a visitor, waits
// on Overpass.
const PUBLIC_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
// Below LiveFountainMap's 20 s client timeout, so the visitor gets our answer
// (results, or an error saying why) rather than a timeout of its own.
const PUBLIC_DEADLINE_MS = 15_000;
// Under half the deadline, so a first mirror that hangs or is too busy to
// answer still leaves the second one its whole turn. A healthy mirror answers
// one city-sized box well inside that.
const PUBLIC_ATTEMPT_TIMEOUT_MS = 7_000;
const NO_STORE = { "Cache-Control": "no-store" };

// Only the point types a client can actually pick. Every real caller asks for
// one of these, and anything else would let any visitor run arbitrary queries
// on the shared Overpass mirrors from our IPs, using up our slots there.
function isPointType(tag: TagFilter): boolean {
  return POINT_TYPES.some((p) => p.key === tag.key && p.value === tag.value);
}

// A failed search as JSON, with a status that says what went wrong upstream:
// 504 when time ran out, 503 for a transient outage or rate limit, 502 when the
// query was refused or something unexpected happened.
function searchFailed(e: unknown): Response {
  if (e instanceof OverpassError) {
    const status = e.timedOut ? 504 : e.retryable ? 503 : 502;
    return Response.json(
      { error: { message: e.message, retryable: e.retryable } },
      { status, headers: NO_STORE },
    );
  }
  // Not an Overpass failure: the client went away mid-search, or a bug.
  if (!(e instanceof Error && e.name === "AbortError")) console.error("[fountains]", e);
  return Response.json(
    { error: { message: "Couldn't load fountains.", retryable: false } },
    { status: 502, headers: NO_STORE },
  );
}

// The public map's fountains for a named region (?region=dc).
export const GET: APIRoute = async ({ request }) => {
  const bounds = regionBounds(new URL(request.url).searchParams.get("region"));
  if (!bounds) {
    return Response.json(
      { error: { message: "Unknown region.", retryable: false } },
      { status: 400, headers: NO_STORE },
    );
  }
  try {
    const fountains = await fetchFountains({ bounds }, PUBLIC_MAP_TAG, "any", 6, true, {
      signal: request.signal,
      deadlineMs: PUBLIC_DEADLINE_MS,
      attemptTimeoutMs: PUBLIC_ATTEMPT_TIMEOUT_MS,
    });
    return Response.json({ fountains }, { headers: { "Cache-Control": PUBLIC_CACHE } });
  } catch (e) {
    return searchFailed(e);
  }
};

// The app's searches: a circle around the runner, or the visible map rectangle.
export const POST: APIRoute = async ({ request }) => {
  const parsed = FountainsRequest.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }
  const { lat, lon, radiusM, bounds, tag, recencyMode, recencyMonths, includeDisused } =
    parsed.data;
  if (!isPointType(tag)) {
    return Response.json(
      { error: { message: "Unsupported point type", retryable: false } },
      { status: 400 },
    );
  }
  // The schema guarantees exactly one mode; assert non-null for the chosen one.
  const region = bounds
    ? { bounds }
    : { lat: lat as number, lon: lon as number, radiusM: radiusM as number };
  try {
    const fountains = await fetchFountains(
      region,
      tag,
      recencyMode,
      recencyMonths,
      includeDisused,
      { signal: request.signal },
    );
    return Response.json({ fountains });
  } catch (e) {
    return searchFailed(e);
  }
};
