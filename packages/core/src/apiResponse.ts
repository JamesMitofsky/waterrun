// Shared rules for reading a reply from the Water Run /api endpoints. The planner
// and the outbox both need the same two answers from a failed call: what to tell
// the user, and whether sending the same request again later can succeed.

// Thrown by an ApiPort when a request exceeds its `timeoutMs`. Distinct from a
// caller-initiated abort so the UI can say "took too long" rather than "offline".
export class ApiTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "ApiTimeoutError";
  }
}

// Statuses where the identical request can succeed later without the user
// changing anything: request timeout, rate limiting, and any server/upstream error.
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

// A failure before any HTTP response arrived: offline, DNS, connection reset, or
// our own timeout. fetch() signals all network failures with a TypeError ("Failed
// to fetch" on web, "Network request failed" on React Native).
export function isTransportError(e: unknown): boolean {
  if (e instanceof ApiTimeoutError || e instanceof TypeError) return true;
  return e instanceof Error && e.name === "AbortError";
}

type ErrorBody = {
  error?: unknown;
  retryable?: unknown;
};

// The human-readable reason in one of the error shapes our endpoints send:
// `{ error: "text" }`, `{ error: { message } }`, or a zod `flattenError` tree
// (`{ error: { formErrors, fieldErrors } }`). Undefined when the body has none.
export function apiErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as ErrorBody).error;
  if (typeof err === "string") return err || undefined;
  if (!err || typeof err !== "object") return undefined;
  const e = err as { message?: unknown; formErrors?: unknown; fieldErrors?: unknown };
  if (typeof e.message === "string" && e.message) return e.message;
  const form = Array.isArray(e.formErrors) ? e.formErrors.filter((m) => typeof m === "string") : [];
  const fields =
    e.fieldErrors && typeof e.fieldErrors === "object"
      ? Object.values(e.fieldErrors as Record<string, unknown>)
          .flat()
          .filter((m): m is string => typeof m === "string")
      : [];
  const all = [...form, ...fields];
  return all.length ? all.join(", ") : undefined;
}

// An explicit `retryable` flag from the server (top-level or inside `error`), if any.
function explicitRetryable(body: unknown): boolean | undefined {
  if (!body || typeof body !== "object") return undefined;
  const top = (body as ErrorBody).retryable;
  if (typeof top === "boolean") return top;
  const err = (body as ErrorBody).error;
  if (err && typeof err === "object") {
    const inner = (err as { retryable?: unknown }).retryable;
    if (typeof inner === "boolean") return inner;
  }
  return undefined;
}

export type ApiReply<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; retryable: boolean; body: unknown };

// Read a Response without ever throwing on a body that isn't ours. A platform
// error page (Vercel 504 HTML, a captive-portal login page) fails `r.json()`;
// that must surface as a retryable failure with a plain message, not as a raw
// "JSON Parse error: Unexpected character: <" shown to the user.
export async function readApiJson<T = unknown>(
  r: Response,
  fallback = "Something went wrong. Please try again.",
): Promise<ApiReply<T>> {
  let body: unknown = undefined;
  let parsed = false;
  try {
    body = await r.json();
    parsed = true;
  } catch {
    // Not JSON — handled below.
  }
  if (r.ok) {
    if (parsed) return { ok: true, status: r.status, data: body as T };
    // A 2xx that isn't JSON came from something in between (proxy, captive
    // portal), not our API, so the real request never happened: retry later.
    return {
      ok: false,
      status: r.status,
      message: "Couldn't reach the server. Check your connection and try again.",
      retryable: true,
      body,
    };
  }
  return {
    ok: false,
    status: r.status,
    message: apiErrorMessage(body) ?? fallback,
    retryable: explicitRetryable(body) ?? isTransientStatus(r.status),
    body,
  };
}
