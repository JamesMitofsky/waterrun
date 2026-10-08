import type { APIRoute } from "astro";
import { z } from "zod";
import { getOsmToken } from "@/lib/osmToken";
import { CreateNodeRequest } from "@rosm/core/schemas";
import {
  openChangeset,
  createNode,
  applyAction,
  surveyDateFor,
  changesetUrl,
  isChangesetUnusable,
  logOsmWrite,
  osmFailure,
} from "@/lib/osm";
import { readJsonBody } from "@/lib/requestBody";

export const prerender = false;

const CHANGESET_COMMENT = "Survey: add drinking water / amenity point";

// The client can hand us a changeset id that can no longer take edits: closed
// by OSM (idle timeout, or an id persisted from a finished session) or owned by
// an OSM account the user has since switched away from. Recover by opening a
// fresh changeset — once — and retrying the same create.
async function createWithRetry(
  token: string,
  lat: number,
  lon: number,
  tags: Record<string, string>,
  changesetId: number,
  reopened = false,
): Promise<{ nodeId: number; changesetId: number }> {
  try {
    return { changesetId, nodeId: await createNode(token, lat, lon, tags, changesetId) };
  } catch (e) {
    if (!isChangesetUnusable(e) || reopened) throw e;
    const fresh = await openChangeset(token, CHANGESET_COMMENT);
    return createWithRetry(token, lat, lon, tags, fresh, true);
  }
}

// Create a new OSM node for a point the surveyor found on the ground but that
// isn't yet in OSM. Tags it with the point type being surveyed plus a
// check_date (it was just observed), and any survey extras (audience, seasonal,
// note) — routed through the same confirm transform as an edit so a new node
// carries identical tags to a freshly re-surveyed one.
export const POST: APIRoute = async ({ request }) => {
  const token = await getOsmToken(request);
  if (!token) return Response.json({ error: "not signed in to OSM" }, { status: 401 });

  const body = await readJsonBody(request);
  const parsed = CreateNodeRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }
  const { lat, lon, tag, extras } = parsed.data;

  try {
    const initialChangeset =
      parsed.data.changesetId ?? (await openChangeset(token, CHANGESET_COMMENT));

    const checkDate = surveyDateFor(body);
    const tags = applyAction({ [tag.key]: tag.value }, "confirm", tag.key, checkDate, extras);
    const { nodeId, changesetId } = await createWithRetry(token, lat, lon, tags, initialChangeset);
    logOsmWrite({ nodeId, action: "create", changesetId, newVersion: 1 });

    return Response.json({
      changesetId,
      changesetUrl: changesetUrl(changesetId),
      nodeId,
      lat,
      lon,
      tags,
      summary: `added ${tag.key}=${tag.value}`,
    });
  } catch (e) {
    const { status, error, retryable } = osmFailure(e);
    return Response.json({ error, retryable }, { status });
  }
};
