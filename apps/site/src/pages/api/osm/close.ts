import type { APIRoute } from "astro";
import { z } from "zod";
import { getOsmToken } from "@/lib/osmToken";
import {
  closeChangeset,
  changesetUrl,
  isChangesetClosed,
  isChangesetNotOwned,
  osmFailure,
} from "@/lib/osm";
import { readJsonBody } from "@/lib/requestBody";

export const prerender = false;

// The id lands in the OSM URL path, so it must be a real changeset id.
const CloseRequest = z.object({ changesetId: z.number().int().positive().optional() });

// Close the run's changeset when the run ends.
export const POST: APIRoute = async ({ request }) => {
  const token = await getOsmToken(request);
  if (!token) return Response.json({ ok: false, error: "not signed in" }, { status: 401 });
  const parsed = CloseRequest.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return Response.json({ ok: false, error: "invalid changeset id" }, { status: 400 });
  }
  const { changesetId } = parsed.data;
  if (!changesetId) return Response.json({ ok: true });
  try {
    await closeChangeset(token, changesetId);
    return Response.json({ ok: true, changesetUrl: changesetUrl(changesetId) });
  } catch (e) {
    // Nothing left to close: OSM already closed it (idle timeout), or it belongs
    // to an OSM account the user has since switched away from and will close on
    // its own. Failing here would leave the run impossible to finish.
    if (isChangesetClosed(e)) {
      return Response.json({ ok: true, changesetUrl: changesetUrl(changesetId) });
    }
    if (isChangesetNotOwned(e)) return Response.json({ ok: true });
    // Edits already PUT are live regardless; the changeset also auto-closes
    // server-side after idle. Surface the reason so the user knows.
    const { status, error, retryable } = osmFailure(e);
    return Response.json(
      {
        ok: false,
        error: `${error} (edits already saved; changeset auto-closes later)`,
        retryable,
      },
      { status },
    );
  }
};
