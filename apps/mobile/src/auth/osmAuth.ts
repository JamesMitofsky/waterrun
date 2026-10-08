import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import cfg from "@rosm/core/appConfig.json";
import { NATIVE_AUTH_CALLBACK } from "@rosm/core/nativeAuth";
import { apiUrl } from "../ports/api";
import { storeToken, clearToken } from "./authStore";

// The whole OAuth dance (PKCE, state, token exchange against OSM) runs server-side,
// exactly as it did for the Capacitor build. We open the server's ?native=1 entry
// in an ASWebAuthenticationSession; the server redirects to rosm://osm-callback?token=…
// and openAuthSessionAsync hands that URL straight back. The router never handles
// it (see app/+native-intent).
const CALLBACK = `${cfg.scheme}://${NATIVE_AUTH_CALLBACK}`;

export type SignInResult = { ok: boolean; error?: string };

export async function signInOsm(): Promise<SignInResult> {
  const authUrl = apiUrl("/api/osm/auth?native=1");
  // ASWebAuthenticationSession needs an absolute https URL; a relative one (empty API
  // base) throws natively. Fail with a clear message instead of crashing the app.
  if (!/^https?:\/\//.test(authUrl)) {
    return { ok: false, error: "Backend URL not configured (EXPO_PUBLIC_API_BASE)." };
  }
  try {
    const res = await WebBrowser.openAuthSessionAsync(authUrl, CALLBACK);
    if (res.type !== "success") return { ok: false }; // user cancelled / dismissed
    const { queryParams } = Linking.parse(res.url);
    const token = typeof queryParams?.token === "string" ? queryParams.token : null;
    const error = typeof queryParams?.error === "string" ? queryParams.error : null;
    if (token) {
      await storeToken(token);
      return { ok: true };
    }
    return { ok: false, error: error ?? "Sign-in failed." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Sign-in failed." };
  }
}

export async function signOutOsm(): Promise<void> {
  await clearToken();
}
