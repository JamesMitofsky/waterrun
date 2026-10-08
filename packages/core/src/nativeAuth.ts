// The native app's OSM sign-in: the link the token comes back on, and which
// keychain entry holds it. The OAuth dance itself runs server-side; the app
// only keeps the bearer token it gets.

// The server hands the token back on <scheme>://osm-callback?token=… (the
// site's /api/osm/callback builds it from the same scheme).
export const NATIVE_AUTH_CALLBACK = "osm-callback";

// Whether a URL the app was opened with is that callback, in any of the forms
// the router may see it: waterrun://osm-callback?…, waterrun:///osm-callback, or a
// bare /osm-callback path.
export function isNativeAuthCallback(url: string): boolean {
  const rest = url.replace(/^[a-z][a-z0-9+.-]*:/i, "").replace(/^\/+/, "");
  return rest.split(/[/?#]/, 1)[0] === NATIVE_AUTH_CALLBACK;
}

// The token's keychain entry is namespaced by API host, so a dev/sandbox token
// and a production one coexist on the same device: pointing a dev build at
// another backend reads a different entry instead of clobbering the signed-in
// one. SecureStore keys must match [A-Za-z0-9._-]; hostnames fit, but a
// `:port` suffix doesn't, so any other character becomes `_`.
export function tokenKeyFor(host: string): string {
  return host ? `osm_token_${host.replace(/[^A-Za-z0-9._-]/g, "_")}` : "osm_token";
}
