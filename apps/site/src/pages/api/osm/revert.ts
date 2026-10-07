import type { APIRoute } from "astro";
import { z } from "zod";
import { getOsmToken } from "@/lib/osmToken";
import { RevertRequest } from "@rosm/core/schemas";
import {
  openChangeset,
  getNode,
  getNodeVersion,
  putNode,
  deleteNode,
  changesetUrl,
  OsmApiError,
  isChangesetUnusable,
  logOsmWrite,
  osmFailure,
  type NodeData,
} from "@/lib/osm";
import { readJsonBody } from "@/lib/requestBody";

export const prerender = false;

const CHANGESET_COMMENT = "Revert: undo survey update";

// One revert write. Edits restore the tags of the version before ours (position
// and current version stay as-is); creates delete the node outright. Recovers
// once from a changeset that can't take the write (closed by idle timeout, an
// id persisted from a finished session, or another OSM account's) — but never
// retries a version conflict: by the time we're here the version was checked,
// so a fresh 409 means a concurrent editor won the race and the undo must abort
// rather than clobber their work.
async function revertWithRetry(
  token: string,
  req: z.infer<typeof RevertRequest>,
  current: NodeData,
  changesetId: number,
  reopened = false,
): Promise<{ newVersion: number; changesetId: number }> {
  try {
    if (req.kind === "create") {
      return { changesetId, newVersion: await deleteNode(token, req.nodeId, current, changesetId) };
    }
    const prev = await getNodeVersion(token, req.nodeId, req.sentVersion - 1);
    return {
      changesetId,
      newVersion: await putNode(token, req.nodeId, { ...current, tags: prev.tags }, changesetId),
    };
  } catch (e) {
    if (isChangesetUnusable(e) && !reopened) {
      const fresh = await openChangeset(token, CHANGESET_COMMENT);
      return revertWithRetry(token, req, current, fresh, true);
    }
    throw e;
  }
}

export const POST: APIRoute = async ({ request }) => {
  const token = await getOsmToken(request);
  if (!token) return Response.json({ error: "not signed in to OSM" }, { status: 401 });

  const parsed = RevertRequest.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }
  const { nodeId, kind, sentVersion } = parsed.data;

  try {
    // Read the node before touching any changeset, so an aborted undo leaves
    // nothing behind on OSM.
    const current = await getNode(token, nodeId).catch((e) => {
      // Undoing a create when the node is already gone: nothing to do.
      if (kind === "create" && e instanceof OsmApiError && e.status === 410) return null;
      throw e;
    });
    if (current === null) return Response.json({ nodeId, alreadyGone: true });

    // Only undo what we submitted. A different current version means someone
    // else edited (or deleted+recreated) the node since — abort instead of
    // silently wiping their change.
    if (current.version !== sentVersion) {
      return Response.json(
        { error: "point was changed by someone else since your edit — undo aborted" },
        { status: 409 },
      );
    }

    const initialChangeset =
      parsed.data.changesetId ?? (await openChangeset(token, CHANGESET_COMMENT));
    const { newVersion, changesetId } = await revertWithRetry(
      token,
      parsed.data,
      current,
      initialChangeset,
    );
    logOsmWrite({ nodeId, action: "revert", changesetId, newVersion });

    return Response.json({
      changesetId,
      changesetUrl: changesetUrl(changesetId),
      nodeId,
      newVersion,
    });
  } catch (e) {
    const { status, error, retryable } = osmFailure(e);
    return Response.json({ error, retryable }, { status });
  }
};
