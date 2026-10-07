import type { APIRoute } from "astro";
import { exchangeToken, safeReturnPath } from "@/lib/osm";
import { SCHEME } from "@/lib/appConfig";

export const prerender = false;

// The app's deep link back from sign-in. Built from the shared config so it
// can't drift from the scheme the app actually registers.
const NATIVE_CALLBACK = `${SCHEME}://osm-callback`;

// OAuth2 redirect target: verify state, exchange code, deliver the token.
//   web    → store it in an httpOnly cookie, bounce to the app.
//   native → hand it back through the app's deep link (the app stores it in the
//            native keychain and sends it as a Bearer header thereafter).
export const GET: APIRoute = async ({ request, cookies }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const verifier = cookies.get("osm_pkce")?.value;
  const savedState = cookies.get("osm_state")?.value;
  const native = cookies.get("osm_native")?.value === "1";
  const returnTo = cookies.get("osm_return")?.value;

  // Transient PKCE/state cookies are cleared on every exit path. Set-Cookie
  // headers from `cookies` are merged onto whatever Response we return.
  const clearTransient = () => {
    cookies.delete("osm_pkce", { path: "/" });
    cookies.delete("osm_state", { path: "/" });
    cookies.delete("osm_native", { path: "/" });
    cookies.delete("osm_return", { path: "/" });
  };
  const redirectTo = (dest: string) =>
    new Response(null, { status: 302, headers: { Location: dest } });
  const fail = (msg: string) => {
    clearTransient();
    return redirectTo(
      native
        ? `${NATIVE_CALLBACK}?error=${encodeURIComponent(msg)}`
        : `${url.origin}/?osm=error&msg=${encodeURIComponent(msg)}`,
    );
  };

  if (!code || !state || !verifier || state !== savedState) {
    return fail("invalid oauth state");
  }

  try {
    const token = await exchangeToken(code, verifier, `${url.origin}/api/osm/callback`);
    clearTransient();
    if (native) {
      return redirectTo(`${NATIVE_CALLBACK}?token=${encodeURIComponent(token)}`);
    }
    // Return to wherever sign-in started (re-validated: the cookie came back
    // from the browser), else home.
    const back = returnTo ? safeReturnPath(returnTo, url.origin) : null;
    const dest = new URL(back ?? "/", url.origin);
    dest.searchParams.set("osm", "ok");
    cookies.set("osm_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return redirectTo(dest.toString());
  } catch (e) {
    return fail((e as Error).message);
  }
};
