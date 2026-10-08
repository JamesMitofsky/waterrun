import type { APIRoute } from "astro";
import crypto from "node:crypto";
import { makePkce, authUrl, safeReturnPath } from "@/lib/osm";

export const prerender = false;

// Start OAuth2 login: redirect to OSM authorize with PKCE.
// `?native=1` marks a native-app sign-in (the Expo app): the callback returns the
// token via the app's deep link instead of an httpOnly cookie (cookies don't
// reach the native origin). The PKCE/state hop itself still works — auth + callback
// both run on this origin inside the same in-app browser session.
export const GET: APIRoute = async ({ request, cookies, redirect }) => {
  const url = new URL(request.url);
  const native = url.searchParams.get("native") === "1";
  const redirectUri = `${url.origin}/api/osm/callback`;
  const { verifier, challenge } = makePkce();
  const state = crypto.randomBytes(8).toString("hex");
  const opts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: url.protocol === "https:",
    path: "/",
    maxAge: 600,
  };
  cookies.set("osm_pkce", verifier, opts);
  cookies.set("osm_state", state, opts);
  // Every attempt states its own mode and destination, clearing what an earlier,
  // abandoned attempt left behind: the app's sign-in sheet shares the browser's
  // cookie jar, so a stale osm_native would send a later web sign-in's token to
  // the app's deep link instead of setting the cookie.
  if (native) cookies.set("osm_native", "1", opts);
  else cookies.delete("osm_native", { path: "/" });
  // Remember where the sign-in started so the callback can return there. Only
  // a path that stays on this origin — an open-redirect guard.
  const returnTo = safeReturnPath(url.searchParams.get("returnTo") ?? "", url.origin);
  if (returnTo) cookies.set("osm_return", returnTo, opts);
  else cookies.delete("osm_return", { path: "/" });
  return redirect(authUrl(redirectUri, challenge, state));
};
