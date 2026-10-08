// Shared rules for every request this server makes to someone else's service
// (the OSM API, Overpass, OpenFreeMap). Each call gets a hard time limit, so a
// stalled upstream costs one bounded wait instead of pinning the function until
// the platform kills it and the client gets an HTML 504 it can't parse. Each
// call also names the app, as the OSM and Overpass usage policies ask: Node's
// default "node" agent is the first thing their operators throttle, and Vercel's
// egress IPs are shared with everyone else's.
import { USER_AGENT } from "@water-run/core/identity";

// The upstream did not finish answering within its time limit. Distinct from a
// caller abort (the client went away) and from a network failure (TypeError),
// so routes can answer 504 rather than 503.
export class UpstreamTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`${new URL(url).host} did not answer within ${timeoutMs}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

// The upstream couldn't be reached, or the connection broke before the whole
// reply arrived (DNS, refused, reset). Retrying later may work.
export class UpstreamNetworkError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(`Couldn't reach ${new URL(url).host}`, { cause });
    this.name = "UpstreamNetworkError";
  }
}

export type UpstreamInit = Omit<RequestInit, "headers" | "signal"> & {
  timeoutMs: number;
  // The caller's own cancellation, typically the incoming request's signal.
  // Best effort only: Vercel aborts it on client disconnect only when request
  // cancellation is enabled, so the time limit is what actually bounds the work.
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

// Statuses whose reply has no body, which a Response can't be rebuilt with.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// fetch() with a time limit that covers the whole exchange: the reply body is
// read before this resolves, so a server that sends its headers and then stalls
// mid-body is cut off too. Failures come out typed: UpstreamTimeoutError on
// expiry, UpstreamNetworkError when the connection failed, and a caller abort
// rejects with the signal's own reason, as fetch does.
export async function upstreamFetch(
  url: string,
  { timeoutMs, signal, headers, ...init }: UpstreamInit,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...headers, "User-Agent": USER_AGENT },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const body = NULL_BODY_STATUSES.has(res.status) ? null : await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (timeout.aborted) throw new UpstreamTimeoutError(url, timeoutMs);
    throw new UpstreamNetworkError(url, e);
  }
}

// A short, single-line excerpt of an upstream error body that is fit to show a
// user. Empty for an HTML page: that is a proxy or CDN error page, never a
// message meant for us, and a wall of markup in an error banner helps no one.
export function upstreamSnippet(body: string, max = 160): string {
  const text = body.trim();
  if (/^<|<html|<!doctype/i.test(text)) return "";
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
