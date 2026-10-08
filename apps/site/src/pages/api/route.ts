import type { APIRoute } from "astro";
import { RouteRequest } from "@water-run/core/schemas";
import { footRoute, RouteError } from "@water-run/core/brouter";
import { haversine, type Pt } from "@water-run/core/geo";

export const prerender = false;

// This endpoint is public and forwards straight to brouter.de, one volunteer
// server. Without limits anyone could use it as a free proxy for huge or
// continent-spanning routes and get our egress IPs throttled or banned for every
// real user. The planner's own requests sit far inside these.
//
// Waypoints per request. Generous because auto-pickup is uncapped: spread-out
// pins in a dense city have produced 200+ stops.
const MAX_ROUTE_POINTS = 300;
// Diagonal of the waypoints' bounding box. A run planned from the 4-mile search
// spans ~13 km; this leaves room for long point-to-point runs.
const MAX_ROUTE_SPAN_M = 100_000;

// Why a parsed request is out of bounds, or null when it can be routed.
function outOfBounds(points: Pt[]): string | null {
  if (points.length > MAX_ROUTE_POINTS) {
    return `This route has too many stops to plan (${points.length}; the limit is ${MAX_ROUTE_POINTS}). Remove some and try again.`;
  }
  if (points.some((p) => Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) {
    return "A point on this route has invalid coordinates.";
  }
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const span = haversine(
    { lat: Math.min(...lats), lon: Math.min(...lons) },
    { lat: Math.max(...lats), lon: Math.max(...lons) },
  );
  if (span > MAX_ROUTE_SPAN_M) {
    return `This route covers too large an area to plan (more than ${MAX_ROUTE_SPAN_M / 1000} km across).`;
  }
  return null;
}

// Every failure is `{ error: string, retryable: boolean }`, plus `island` when a
// point can't be reached on foot, so clients never have to guess the shape.
function fail(status: number, error: string, retryable = false, island?: Pt): Response {
  return Response.json({ error, retryable, island }, { status });
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid route request: the body isn't JSON.");
  }
  const parsed = RouteRequest.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    return fail(400, `Invalid route request (${issues.join("; ")}).`);
  }
  const { points, loop } = parsed.data;
  const tooBig = outOfBounds(points);
  if (tooBig) return fail(400, tooBig);

  try {
    // Stop waiting on BRouter once our own client has gone away.
    const route = await footRoute(points, loop, request.signal);
    return Response.json(route);
  } catch (e) {
    if (!(e instanceof RouteError)) {
      // Nobody is listening for a reply to a request its client abandoned.
      if (request.signal.aborted) return fail(503, "Request cancelled.", true);
      console.error("[api/route] unexpected failure:", e);
      return fail(500, "Routing failed unexpectedly. Please try again.");
    }
    // `island` (when present) is the unreachable point's coords, so the client
    // can highlight exactly where the route breaks. 503 (Service Unavailable)
    // when BRouter is busy, slow or unreachable; 502 when it refused the route.
    return fail(e.retryable ? 503 : 502, e.message, e.retryable, e.island);
  }
};
