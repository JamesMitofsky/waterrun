// The native app's OSM sign-in token: which keychain entry holds it. The OAuth
// dance itself runs server-side; the app only keeps the bearer token it gets.
import cfg from "../appConfig.json";

// The API host that builds released before the move to waterrun.app called,
// and so the host their keychain entry for the token is named after.
const LEGACY_API_HOST = "rosm.app";

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

// The host release builds call.
const PRODUCTION_HOST = hostOf(cfg.apiBase);

// The token's keychain entry is namespaced by API host, so a dev/sandbox token
// and a production one coexist on the same device: pointing a dev build at
// another backend reads a different entry instead of clobbering the signed-in
// one. SecureStore keys must match [A-Za-z0-9._-]; hostnames fit, but a
// `:port` suffix doesn't, so any other character becomes `_`.
export function tokenKeyFor(host: string): string {
  return host ? `osm_token_${host.replace(/[^A-Za-z0-9._-]/g, "_")}` : "osm_token";
}

// The entry an older build may have left the token for `host` under, if any.
// Only the production host takes it over: that token was issued through the
// production backend, and a dev or sandbox entry must never be filled with it.
export function legacyTokenKey(host: string): string | null {
  return host === PRODUCTION_HOST && host !== LEGACY_API_HOST ? tokenKeyFor(LEGACY_API_HOST) : null;
}

// The keychain, as far as the token needs it (expo-secure-store on device).
export type SecretStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

// The stored token for `host`. On the first launch after the move, the token
// is moved over from the legacy entry, so nobody is signed out by it. Rejects
// when an entry can't be read (a locked keychain), so the caller doesn't take
// that for "signed out" and can read again later. Saving the move is
// best-effort: if it fails, the legacy token still signs this session in and
// the next launch tries again.
export async function readStoredToken(keychain: SecretStore, host: string): Promise<string | null> {
  const key = tokenKeyFor(host);
  const token = await keychain.get(key);
  const legacyKey = token == null ? legacyTokenKey(host) : null;
  if (!legacyKey) return token;
  const legacy = await keychain.get(legacyKey);
  if (legacy == null) return null;
  try {
    await keychain.set(key, legacy);
    await keychain.remove(legacyKey);
  } catch {
    // Read from the legacy entry again next launch.
  }
  return legacy;
}

// Delete the stored token for `host`, the legacy entry included: a legacy
// token left behind would sign the user back in on the next launch. Tries
// both, then rejects if either failed.
export async function forgetStoredToken(keychain: SecretStore, host: string): Promise<void> {
  const keys = [tokenKeyFor(host), legacyTokenKey(host)].filter((k): k is string => k !== null);
  const results = await Promise.allSettled(keys.map((k) => keychain.remove(k)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}
