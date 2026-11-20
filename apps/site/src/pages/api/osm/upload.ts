import type { APIRoute } from "astro";
import { z } from "zod";
import { getOsmToken } from "@/lib/osmToken";
import { UploadRequest, type UploadCreate, type UploadEdit } from "@water-run/core/uploadRequest";
import {
  applyAction,
  changesetUrl,
  checkDateFor,
  closeChangeset,
  downloadChangeset,
  getChangeset,
  getNodes,
  isChangesetClosed,
  isChangesetUnusable,
  isVersionConflict,
  logOsmWrite,
  openChangeset,
  osmChangeXml,
  osmFailure,
  OsmApiError,
  RUN_CHANGESET_COMMENT,
  sameTags,
  surveyDateFor,
  uploadChangeset,
  type DiffCreate,
  type DiffModify,
} from "@/lib/osm";
import { recordPointWrite } from "@/lib/pointCache";
import { readJsonBody } from "@/lib/requestBody";

export const prerender = false;

// A version conflict means someone saved a point between our read and the
// upload. The upload is atomic, so nothing of ours was written: read again and
// retry, a few times.
const MAX_ATTEMPTS = 3;

const GONE = "This point no longer exists on the map.";

type Written = { key: string; nodeId: number; newVersion: number };

type UploadAnswer = {
  changesetId: number;
  changesetUrl: string;
  written: Written[];
  unchanged: string[];
  alreadyApplied?: true;
};

const answer = (changesetId: number, rest: Omit<UploadAnswer, "changesetId" | "changesetUrl">) =>
  Response.json({ changesetId, changesetUrl: changesetUrl(changesetId), ...rest });

// Close a changeset whose work is done. OSM closes an idle one within the
// hour by itself, so a failure here costs nothing and isn't reported.
async function closeQuietly(token: string, id: number): Promise<void> {
  try {
    await closeChangeset(token, id);
  } catch (e) {
    console.warn("[upload] couldn't close changeset", id, e);
  }
}

// OSM keeps 7 decimal places of a coordinate.
const samePlace = (a: number, b: number) => Math.abs(a - b) < 1.5e-7;

// The answer for a resend whose first try already landed (its reply was lost):
// reconstructed from what the changeset holds. The ids are a nicety for the
// app's history, so failing to read them still answers success.
async function alreadyApplied(
  token: string,
  changesetId: number,
  edits: UploadEdit[],
  creates: UploadCreate[],
): Promise<UploadAnswer> {
  const written: Written[] = [];
  try {
    const held = await downloadChangeset(token, changesetId);
    for (const e of edits) {
      const versions = held.modified.filter((m) => m.id === e.nodeId).map((m) => m.version);
      if (versions.length) {
        written.push({ key: e.key, nodeId: e.nodeId, newVersion: Math.max(...versions) });
      }
    }
    const pool = [...held.created];
    for (const c of creates) {
      const at = pool.findIndex((n) => samePlace(n.lat, c.lat) && samePlace(n.lon, c.lon));
      if (at === -1) continue;
      written.push({ key: c.key, nodeId: pool[at].id, newVersion: pool[at].version });
      pool.splice(at, 1);
    }
  } catch (e) {
    console.warn("[upload] couldn't read back changeset", changesetId, e);
  }
  return {
    changesetId,
    changesetUrl: changesetUrl(changesetId),
    written,
    unchanged: [],
    alreadyApplied: true,
  };
}

// Write a whole run's reviewed updates to OSM: one changeset, one atomic diff
// upload (OSM applies every change or none). The app opens the changeset first
// (/api/osm/changeset) and stores its id, so this endpoint can be called again
// with the same request after a lost reply: a changeset that already holds
// changes means the first try landed, and it is answered without writing again.
//
// Replies:
//   200 — written (or already written); `written` maps each item's key to the
//         node and version OSM now has, `unchanged` lists items that changed
//         nothing (the point already said exactly that)
//   422 — `problems` names items that can't be written (the point is gone);
//         nothing was written, the user decides what to do with them
//   other — osmFailure's status and `retryable`, as for a single edit
// Any reply carries `changesetId` when the work moved to a fresh changeset, so
// the app sends later tries there.
export const POST: APIRoute = async ({ request }) => {
  const token = await getOsmToken(request);
  if (!token) return Response.json({ error: "not signed in" }, { status: 401 });

  const body = await readJsonBody(request);
  const parsed = UploadRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.flattenError(parsed.error) }, { status: 400 });
  }
  const { edits, creates } = parsed.data;
  let changesetId = parsed.data.changesetId;
  let moved = false;
  const fresh = async () => {
    changesetId = await openChangeset(token, RUN_CHANGESET_COMMENT);
    moved = true;
  };

  try {
    // A resend whose first try landed? The changeset is this submission's
    // alone, so any change in it is ours.
    let info: { open: boolean; changesCount: number } | null;
    try {
      info = await getChangeset(token, changesetId);
    } catch (e) {
      if (!(e instanceof OsmApiError && e.status === 404)) throw e;
      info = null; // no such changeset: start one
    }
    if (info && info.changesCount > 0) {
      if (info.open) await closeQuietly(token, changesetId);
      return Response.json(await alreadyApplied(token, changesetId, edits, creates));
    }
    if (!info || !info.open) await fresh();

    let reopened = false;
    for (let attempt = 1; ; attempt++) {
      const nodes = await getNodes(
        token,
        edits.map((e) => e.nodeId),
      );
      const problems = edits
        .filter((e) => !nodes.get(e.nodeId)?.visible)
        .map((e) => ({ key: e.key, error: GONE }));
      if (problems.length) {
        return Response.json(
          {
            error: "Some points no longer exist on the map.",
            retryable: false,
            problems,
            changesetId: moved ? changesetId : undefined,
          },
          { status: 422 },
        );
      }

      const modifies: (DiffModify & { key: string })[] = [];
      const unchanged: string[] = [];
      for (const e of edits) {
        const node = nodes.get(e.nodeId)!;
        const checkDate = checkDateFor(node.tags.check_date, surveyDateFor(e));
        const tags = applyAction(node.tags, e.action, e.tagKey, checkDate, e.extras);
        if (sameTags(node.tags, tags)) unchanged.push(e.key);
        else modifies.push({ ...node, tags, key: e.key });
      }
      const created: (DiffCreate & { key: string })[] = creates.map((c) => ({
        key: c.key,
        tempId: c.tempId,
        lat: c.lat,
        lon: c.lon,
        // The same transform a single create uses, so a point added on a run
        // carries the same tags as one re-surveyed.
        tags: applyAction(
          { [c.tag.key]: c.tag.value },
          "confirm",
          c.tag.key,
          surveyDateFor(c),
          c.extras,
        ),
      }));

      if (modifies.length + created.length === 0) {
        // Every point already said what the run found. An empty changeset
        // is closed and left; OSM keeps it but it holds nothing.
        await closeQuietly(token, changesetId);
        return answer(changesetId, { written: [], unchanged });
      }

      let diff;
      try {
        diff = await uploadChangeset(
          token,
          changesetId,
          osmChangeXml(changesetId, created, modifies),
        );
      } catch (e) {
        if (isVersionConflict(e) && attempt < MAX_ATTEMPTS) continue;
        if (isChangesetUnusable(e) && !reopened) {
          // Closed since we looked (idle timeout), or another account's.
          // A closed one might hold a duplicate request's upload: ask again.
          if (isChangesetClosed(e)) {
            const again = await getChangeset(token, changesetId);
            if (again.changesCount > 0) {
              return Response.json(await alreadyApplied(token, changesetId, edits, creates));
            }
          }
          await fresh();
          reopened = true;
          continue;
        }
        throw e;
      }

      const byOldId = new Map(diff.map((d) => [d.oldId, d]));
      const written: Written[] = [];
      const notes: Promise<void>[] = [];
      for (const m of modifies) {
        const d = byOldId.get(m.id);
        if (!d) continue;
        written.push({ key: m.key, nodeId: m.id, newVersion: d.newVersion });
        logOsmWrite({
          nodeId: m.id,
          action: "upload-modify",
          changesetId,
          newVersion: d.newVersion,
        });
        notes.push(recordPointWrite({ id: m.id, lat: m.lat, lon: m.lon, tags: m.tags }));
      }
      for (const c of created) {
        const d = byOldId.get(c.tempId);
        if (!d) continue;
        written.push({ key: c.key, nodeId: d.newId, newVersion: d.newVersion });
        logOsmWrite({
          nodeId: d.newId,
          action: "upload-create",
          changesetId,
          newVersion: d.newVersion,
        });
        notes.push(recordPointWrite({ id: d.newId, lat: c.lat, lon: c.lon, tags: c.tags }));
      }
      await Promise.all(notes);
      await closeQuietly(token, changesetId);
      return answer(changesetId, { written, unchanged });
    }
  } catch (e) {
    const { status, error, retryable } = osmFailure(e);
    return Response.json(
      { error, retryable, changesetId: moved ? changesetId : undefined },
      { status },
    );
  }
};
