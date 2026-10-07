import type { APIRoute } from "astro";
import { getUserDetails, osmFailure } from "@/lib/osm";
import { getOsmToken } from "@/lib/osmToken";

export const prerender = false;

// The signed-in user's OSM identity, trimmed to what the UI needs. Kept separate
// from /api/osm/status (polled everywhere) so a status check never costs an OSM
// API roundtrip.
export const GET: APIRoute = async ({ request }) => {
  const token = await getOsmToken(request);
  if (!token) return Response.json({ error: "not signed in" }, { status: 401 });
  try {
    const u = await getUserDetails(token);
    return Response.json({
      id: u.id ?? null,
      username: u.display_name ?? null,
      avatarUrl: u.img?.href ?? null,
      changesetCount: u.changesets?.count ?? 0,
      accountCreated: u.account_created ?? null,
    });
  } catch (e) {
    const { status, retryable } = osmFailure(e);
    return Response.json({ error: "couldn't load OSM user", retryable }, { status });
  }
};
