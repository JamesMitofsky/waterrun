import type { ApiPort } from "@rosm/core/ports";
import { ApiTimeoutError } from "@rosm/core/apiResponse";
import cfg from "@rosm/core/appConfig.json";
import { getToken } from "../auth/authStore";
import { kv } from "./storage";

// Absolute base for the Water Run backend (the Astro /api endpoints on Vercel). EAS build
// profiles inject EXPO_PUBLIC_API_BASE; a local `expo start` has no such env, so we
// fall back to the shared appConfig default rather than emitting a relative URL —
// on device a relative URL has no origin and crashes native modules (e.g. the OSM
// auth session). Override via EXPO_PUBLIC_API_BASE when pointing at a preview backend.
//
// Dev-only override: EXPO_PUBLIC_DEV_API_BASE (loaded from apps/mobile/.env.local)
// wins when __DEV__ is true, so Metro-served bundles route through a locally-run
// apps/site pointed at the OSM sandbox instead of writing to production.
const RAW_BASE =
  (__DEV__ && process.env.EXPO_PUBLIC_DEV_API_BASE) ||
  process.env.EXPO_PUBLIC_API_BASE ||
  cfg.apiBase ||
  "";
export const API_BASE = RAW_BASE.replace(/\/$/, "");

export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path}`;
}

// The planner draft, though, backs onto the device kv store so a force-quit
// mid-planning can offer "resume" on relaunch — same contract as web /api/draft.
const DRAFT_ROUTE = /^\/api\/draft\b/;
const DRAFT_KEY = "rosm:planner-draft";

const jsonResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });

export const api: ApiPort = {
  apiFetch: async (path, init = {}, { timeoutMs } = {}) => {
    if (DRAFT_ROUTE.test(path)) {
      const method = (init.method ?? "GET").toUpperCase();
      if (method === "POST") kv.set(DRAFT_KEY, typeof init.body === "string" ? init.body : "null");
      if (method === "DELETE") kv.set(DRAFT_KEY, "null");
      return jsonResponse(method === "GET" ? (kv.get(DRAFT_KEY) ?? "null") : "null");
    }
    const headers = new Headers(init.headers);
    const token = getToken();
    if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    if (!timeoutMs) {
      try {
        return await fetch(apiUrl(path), { ...init, headers });
      } catch (e) {
        throw asWebFetchError(e, init.signal);
      }
    }

    // Same contract as the site's apiFetch: abort on expiry and reject with
    // ApiTimeoutError, while still honoring a caller-supplied signal. The timer
    // is left running once the headers arrive, so the deadline covers the whole
    // exchange: a body that stalls mid-stream is aborted too, and reading it then
    // rejects like any other lost reply. Aborting a finished request is a no-op.
    const ctrl = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => ctrl.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
      init.signal?.removeEventListener("abort", onCallerAbort);
    }, timeoutMs);
    if (init.signal) {
      if (init.signal.aborted) ctrl.abort();
      else init.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      return await fetch(apiUrl(path), { ...init, headers, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onCallerAbort);
      if (timedOut) throw new ApiTimeoutError(timeoutMs);
      throw asWebFetchError(e, init.signal);
    }
  },
};

// The app's global fetch is expo/fetch, which rejects every failure (no network,
// reset connection, even an abort) with its own FetchError, a plain Error. Core
// decides "no reply, try again later" by the web fetch contract (a TypeError for
// network failures, an AbortError for aborts; see isTransportError), so translate
// here at the port and keep the original as the cause.
function asWebFetchError(e: unknown, callerSignal?: AbortSignal | null): Error {
  if (e instanceof TypeError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const err = callerSignal?.aborted ? new Error(message) : new TypeError(message);
  if (callerSignal?.aborted) err.name = "AbortError";
  (err as Error & { cause?: unknown }).cause = e;
  return err;
}
