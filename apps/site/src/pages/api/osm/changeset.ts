import type { APIRoute } from "astro";
import { getOsmToken } from "@/lib/osmToken";
import { openChangeset, changesetUrl, osmFailure, RUN_CHANGESET_COMMENT } from "@/lib/osm";

export const prerender = false;

// Open the changeset a run's reviewed updates go into. Its own step, before the
// upload, so the app can store the id first: a resend after a lost reply then
// goes to the same changeset, where /api/osm/upload can tell it already landed.
export const POST: APIRoute = async ({ request }) => {
  const token = await getOsmToken(request);
  if (!token) return Response.json({ error: "not signed in" }, { status: 401 });
  try {
    const changesetId = await openChangeset(token, RUN_CHANGESET_COMMENT);
    return Response.json({ changesetId, changesetUrl: changesetUrl(changesetId) });
  } catch (e) {
    const { status, error, retryable } = osmFailure(e);
    return Response.json({ error, retryable }, { status });
  }
};
