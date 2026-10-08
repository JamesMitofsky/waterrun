// Formspree is a hosted form backend: the browser POSTs straight to an endpoint
// and submissions land in its dashboard/inbox, so the site keeps no server code
// and no database for them. Endpoints come from PUBLIC_ env vars (one per form)
// so each environment can point at its own inbox.

/**
 * The first message in Formspree's JSON error body (`{ errors: [{ message }] }`),
 * the only slice of it we read. Anything else, a non-JSON body included, is
 * `undefined` and falls through to the generic message. A hand-rolled guard
 * rather than a zod schema: this module ships to the browser with the forms,
 * and zod was most of their JS for one optional field.
 */
function firstError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("errors" in body)) return undefined;
  const { errors } = body;
  if (!Array.isArray(errors)) return undefined;
  const first: unknown = errors[0];
  if (typeof first !== "object" || first === null || !("message" in first)) return undefined;
  return typeof first.message === "string" ? first.message : undefined;
}

export type FormspreeResult = { ok: true } | { ok: false; message: string };

/**
 * POST a form payload to Formspree and normalise every outcome — missing
 * endpoint, HTTP error, network failure — into one result shape, so a form
 * component only has to render `message`.
 */
export async function submitToFormspree(
  endpoint: string | undefined,
  payload: Record<string, unknown>,
  unconfiguredMessage = "This form isn't configured yet. Please try again later.",
): Promise<FormspreeResult> {
  if (!endpoint) return { ok: false, message: unconfiguredMessage };
  try {
    // `Accept: application/json` makes Formspree return JSON instead of
    // redirecting to its own thank-you page, so the user stays on this page.
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true };
    return {
      ok: false,
      message:
        firstError(await res.json().catch(() => null)) || "Something went wrong. Please try again.",
    };
  } catch {
    return { ok: false, message: "Network error. Please try again." };
  }
}
