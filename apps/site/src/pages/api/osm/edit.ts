import type { APIRoute } from "astro";
import { z } from "zod";
import { getOsmToken } from "@/lib/osmToken";
import { EditRequest } from "@rosm/core/schemas";
import {
  openChangeset,
  getNode,
  putNode,
  applyAction,
  sameTags,
  surveyDateFor,
  changesetUrl,
  isChangesetUnusable,
  isVersionConflict,
  logOsmWrite,
  osmFailure,
} from "@/lib/osm";
import { readJsonBody } from "@/lib/requestBody";
import { editSummary } from "@rosm/core/editSummary";

export const prerender = false;

const CHANGESET_COMMENT = "Survey: drinking water / amenity status check";
const MAX_ATTEMPTS = 3;

type EditResult = { newVersion: number; changesetId?: number; unchanged?: true };

// One write attempt: re-read the node so the version sent always matches the
// current db version (OSM rejects a stale version with 409), then PUT. The
// changeset is opened only once a write is actually needed.
// Recurses on the two retryable 409 flavors:
//   - unusable changeset (closed by idle timeout, persisted from a finished
//     session, or owned by an OSM account the user has since switched away
//     from): open a fresh changeset — once — and retry the same edit.
//   - version conflict (a concurrent editor bumped the version between our
//     read and write): re-read + retry, up to MAX_ATTEMPTS.
async function putWithRetry(
  token: string,
  edit: z.infer<typeof EditRequest>,
  surveyDate: string,
  changesetId: number | undefined,
  attempt = 1,
  reopened = false,
): Promise<EditResult> {
  const node = await getNode(token, edit.nodeId);
  const tags = applyAction(node.tags, edit.action, edit.tagKey, surveyDate, edit.extras);
  // The node already says exactly what this edit would write. Usually that is
  // the client sending again an edit whose reply it never got (it timed out
  // after OSM had accepted the PUT); answering with the current version instead
  // of writing an identical one makes that resend harmless.
  if (sameTags(node.tags, tags)) return { newVersion: node.version, changesetId, unchanged: true };

  const target = changesetId ?? (await openChangeset(token, CHANGESET_COMMENT));
  try {
    const newVersion = await putNode(token, edit.nodeId, { ...node, tags }, target);
    return { newVersion, changesetId: target };
  } catch (e) {
    if (isChangesetUnusable(e) && !reopened) {
      // Reopening doesn't consume a version-conflict retry: same attempt count.
      return putWithRetry(token, edit, surveyDate, undefined, attempt, true);
    }
    if (isVersionConflict(e) && attempt < MAX_ATTEMPTS) {
      return putWithRetry(token, edit, surveyDate, target, attempt + 1, reopened);
    }
    throw e;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const token = await getOsmToken(request);
  if (!token) return Response.json({ error: "not signed in to OSM" }, { status: 401 });

  const body = await readJsonBody(request);
  const parsed = EditRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }
  const { nodeId, action, tagKey, extras } = parsed.data;
  const surveyDate = surveyDateFor(body);

  try {
    const { newVersion, changesetId, unchanged } = await putWithRetry(
      token,
      parsed.data,
      surveyDate,
      parsed.data.changesetId,
    );
    if (!unchanged) logOsmWrite({ nodeId, action, changesetId, newVersion });

    return Response.json({
      // Absent only when nothing was written and the client had no changeset yet.
      changesetId,
      changesetUrl: changesetId ? changesetUrl(changesetId) : undefined,
      nodeId,
      action,
      newVersion,
      // Nothing was written: `newVersion` is the node's current one, which an
      // undo must not revert, since it may not be ours.
      unchanged,
      summary: editSummary(action, tagKey, surveyDate, extras),
    });
  } catch (e) {
    const { status, error, retryable } = osmFailure(e);
    return Response.json({ error, retryable }, { status });
  }
};
