// One call to the Water Run /api with a deadline, as a reply that never throws
// for network reasons. A request that got no answer (offline, timed out, a
// captive portal) becomes a retryable failure with a plain message, the same as
// a non-JSON error page, instead of "Network request failed" or a JSON parse
// error the user can do nothing with. (The planner store keeps a private copy
// of this; the two should become one.)
import { corePorts } from "./configure";
import { ApiTimeoutError, isTransportError, readApiJson, type ApiReply } from "./apiResponse";

export const UNREACHABLE = "Couldn't reach the server. Check your connection and try again.";
export const TOO_SLOW = "The server took too long to answer. Check your connection and try again.";
export const UNEXPECTED_REPLY = "The server sent an unexpected reply. Please try again.";

// A failure with no reply has no HTTP status; 0 stands in for it. Rejects only
// for a failure that isn't the network's (a bug, not a condition to report).
export async function callApi<T>(
  path: string,
  init: RequestInit,
  timeoutMs: number,
  fallback: string,
): Promise<ApiReply<T>> {
  let r: Response;
  try {
    r = await corePorts().api.apiFetch(path, init, { timeoutMs });
  } catch (e) {
    if (!isTransportError(e)) throw e;
    const message = e instanceof ApiTimeoutError ? TOO_SLOW : UNREACHABLE;
    return { ok: false, status: 0, message, retryable: true, body: undefined };
  }
  return readApiJson<T>(r, fallback);
}

export const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
