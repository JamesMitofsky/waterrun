import * as SecureStore from "expo-secure-store";
import { API_BASE } from "../ports/api";

// The OSM bearer token, cached in memory (read synchronously by the api port) and
// persisted in the iOS keychain / Android keystore via expo-secure-store. A tiny
// listener set notifies the auth gate + status hooks on change.
//
// Namespaced by API host so a dev/sandbox token and a prod TestFlight token can
// coexist on the same device — switching EXPO_PUBLIC_DEV_API_BASE reads from a
// different keychain entry rather than clobbering the previously signed-in one.
// SecureStore keys must match [A-Za-z0-9._-]; hostnames satisfy that with `.` and
// `-`, but a `:port` suffix would not, so any stray char is coerced to `_`.
const host = (() => {
  try {
    return new URL(API_BASE).host;
  } catch {
    return "";
  }
})();
const KEY = host ? `osm_token_${host.replace(/[^A-Za-z0-9._-]/g, "_")}` : "osm_token";
const holder: { token: string | null } = { token: null };
const listeners = new Set<() => void>();

// Bumped by every sign-in and sign-out, so a keychain read that was already
// under way can't overwrite what the user just did with what was stored before.
let generation = 0;

const emit = () => listeners.forEach((l) => l());

export const getToken = (): string | null => holder.token;

export const onAuthChange = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

// Read the stored token into memory. Rejects when the keychain can't be read
// (iOS refuses while the phone is locked, as on a background launch; Android
// when the keystore can't decrypt the entry): nothing changes then, and the
// caller may read again later. Listeners hear about it either way.
export async function loadToken(): Promise<void> {
  const at = generation;
  try {
    const token = (await SecureStore.getItemAsync(KEY)) ?? null;
    if (at === generation) holder.token = token;
  } finally {
    emit();
  }
}

// Sign in. Takes effect at once; if the keychain won't keep the token, this
// session stays signed in and the next launch asks again.
export async function storeToken(token: string): Promise<void> {
  generation++;
  holder.token = token;
  try {
    await SecureStore.setItemAsync(KEY, token);
  } catch (e) {
    console.warn("[auth] couldn't save the token", e);
  } finally {
    emit();
  }
}

// Sign out. Takes effect at once, whatever the keychain says: a failed delete
// leaves the token for the next launch to read, but must not leave Sign out
// doing nothing now.
export async function clearToken(): Promise<void> {
  generation++;
  holder.token = null;
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch (e) {
    console.warn("[auth] couldn't delete the token", e);
  } finally {
    emit();
  }
}
