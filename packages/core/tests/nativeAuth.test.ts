import { describe, expect, it, vi } from "vitest";
import {
  forgetStoredToken,
  legacyTokenKey,
  readStoredToken,
  tokenKeyFor,
  type SecretStore,
} from "../src/nativeAuth";
import cfg from "../appConfig.json";

const PROD = new URL(cfg.apiBase).host;
const PROD_KEY = `osm_token_${PROD}`;
const LEGACY_KEY = "osm_token_rosm.app";
const DEV = "localhost:4321";

// An in-memory keychain with spies, optionally failing chosen calls.
function keychain(
  entries: Record<string, string>,
  fail: Partial<Record<keyof SecretStore, true>> = {},
) {
  const m = new Map(Object.entries(entries));
  const store = {
    get: vi.fn(async (k: string) => {
      if (fail.get) throw new Error("keychain locked");
      return m.get(k) ?? null;
    }),
    set: vi.fn(async (k: string, v: string) => {
      if (fail.set) throw new Error("keychain full");
      m.set(k, v);
    }),
    remove: vi.fn(async (k: string) => {
      if (fail.remove) throw new Error("keychain busy");
      m.delete(k);
    }),
  };
  return { store, entries: m };
}

describe("tokenKeyFor", () => {
  it("names the entry after the API host, keeping keys SecureStore accepts", () => {
    expect(tokenKeyFor("waterrun.app")).toBe("osm_token_waterrun.app");
    expect(tokenKeyFor("192.168.1.10:4321")).toBe("osm_token_192.168.1.10_4321");
    expect(tokenKeyFor("")).toBe("osm_token");
  });
});

describe("legacyTokenKey", () => {
  it("lets only the production host take over the legacy entry", () => {
    expect(PROD).toBe("waterrun.app");
    expect(legacyTokenKey(PROD)).toBe(LEGACY_KEY);
    expect(legacyTokenKey(DEV)).toBeNull();
    expect(legacyTokenKey("run-for-maps-preview.vercel.app")).toBeNull();
    expect(legacyTokenKey("rosm.app")).toBeNull();
  });
});

describe("readStoredToken", () => {
  it("moves the legacy token over on the production host", async () => {
    const { store, entries } = keychain({ [LEGACY_KEY]: "old" });
    expect(await readStoredToken(store, PROD)).toBe("old");
    expect(entries.get(PROD_KEY)).toBe("old");
    expect(entries.has(LEGACY_KEY)).toBe(false);
  });

  it("reads the host's own token and leaves the legacy entry alone", async () => {
    const { store, entries } = keychain({ [PROD_KEY]: "new", [LEGACY_KEY]: "old" });
    expect(await readStoredToken(store, PROD)).toBe("new");
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(entries.get(LEGACY_KEY)).toBe("old");
  });

  it("never fills a dev or sandbox entry with the production token", async () => {
    const { store, entries } = keychain({ [LEGACY_KEY]: "old" });
    expect(await readStoredToken(store, DEV)).toBeNull();
    expect(store.get).toHaveBeenCalledTimes(1);
    expect(store.set).not.toHaveBeenCalled();
    expect(entries.get(LEGACY_KEY)).toBe("old");
  });

  it("is signed out when neither entry has a token", async () => {
    const { store } = keychain({});
    expect(await readStoredToken(store, PROD)).toBeNull();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("still signs in with the legacy token when the move can't be saved", async () => {
    const { store, entries } = keychain({ [LEGACY_KEY]: "old" }, { set: true });
    expect(await readStoredToken(store, PROD)).toBe("old");
    expect(store.remove).not.toHaveBeenCalled();
    expect(entries.get(LEGACY_KEY)).toBe("old"); // moved on a later launch
  });

  it("rejects when the host's own entry can't be read", async () => {
    const { store } = keychain({}, { get: true });
    await expect(readStoredToken(store, PROD)).rejects.toThrow("keychain locked");
  });

  it("rejects, rather than reading as signed out, when the legacy entry can't be read", async () => {
    const { store } = keychain({ [LEGACY_KEY]: "old" });
    store.get.mockImplementation(async (k: string) => {
      if (k === LEGACY_KEY) throw new Error("keychain locked");
      return null;
    });
    await expect(readStoredToken(store, PROD)).rejects.toThrow("keychain locked");
    expect(store.set).not.toHaveBeenCalled();
  });
});

describe("forgetStoredToken", () => {
  it("deletes the legacy entry too on the production host, so sign-out sticks", async () => {
    const { store, entries } = keychain({ [PROD_KEY]: "new", [LEGACY_KEY]: "old" });
    await forgetStoredToken(store, PROD);
    expect(entries.size).toBe(0);
    expect(await readStoredToken(store, PROD)).toBeNull();
  });

  it("leaves the production entries alone on another host", async () => {
    const { store, entries } = keychain({ [tokenKeyFor(DEV)]: "dev", [LEGACY_KEY]: "old" });
    await forgetStoredToken(store, DEV);
    expect([...entries.keys()]).toEqual([LEGACY_KEY]);
  });

  it("tries every entry and rejects when one can't be deleted", async () => {
    const { store } = keychain({ [PROD_KEY]: "new" }, { remove: true });
    await expect(forgetStoredToken(store, PROD)).rejects.toThrow("keychain busy");
    expect(store.remove.mock.calls.map(([k]) => k)).toEqual([PROD_KEY, LEGACY_KEY]);
  });
});
