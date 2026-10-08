import * as SecureStore from "expo-secure-store";
import {
  forgetStoredToken,
  readStoredToken,
  tokenKeyFor,
  type SecretStore,
} from "@rosm/core/nativeAuth";
import { API_BASE } from "../ports/api";

// The OSM bearer token, cached in memory (read synchronously by the api port) and
// persisted in the iOS keychain / Android keystore via expo-secure-store. A tiny
// listener set notifies the auth gate + status hooks on change. The keychain
// entry is named after the API host (see tokenKeyFor).
const host = (() => {
  try {
    return new URL(API_BASE).host;
  } catch {
    return "";
  }
})();
const KEY = tokenKeyFor(host);
const keychain: SecretStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
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

// Read the stored token into memory, carrying it over from the entry older
// builds kept it under (see readStoredToken). Rejects when the keychain can't
// be read (iOS refuses while the phone is locked, as on a background launch;
// Android when the keystore can't decrypt the entry): nothing changes then,
// and the caller may read again later. Listeners hear about it either way.
export async function loadToken(): Promise<void> {
  const at = generation;
  try {
    const token = await readStoredToken(keychain, host);
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
    await keychain.set(KEY, token);
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
    await forgetStoredToken(keychain, host);
  } catch (e) {
    console.warn("[auth] couldn't delete the token", e);
  } finally {
    emit();
  }
}
