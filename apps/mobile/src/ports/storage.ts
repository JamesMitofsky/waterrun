import Storage from "expo-sqlite/kv-store";
import type { KvPort, OutboxStoragePort } from "@water-run/core/ports";
import type { OutboxItem } from "@water-run/core/stores/outbox";

// expo-sqlite/kv-store is a localStorage-/AsyncStorage-compatible key/value store
// backed by SQLite. Its synchronous getItemSync/setItemSync back the KvPort (route
// archive + planner draft), and its async API backs the outbox.

export const kv: KvPort = {
  get: (key) => Storage.getItemSync(key),
  set: (key, value) => Storage.setItemSync(key, value),
  remove: (key) => void Storage.removeItemSync(key),
};

// One row per queued edit (keyed by id) + one row per meta value, mirroring the
// web IndexedDB layout so per-item puts stay atomic (no read-modify-write races).
const ITEM_PREFIX = "water-run:outbox:item:";
const META_PREFIX = "water-run:outbox:meta:";

export const outboxStorage: OutboxStoragePort = {
  getAll: async () => {
    const keys = (await Storage.getAllKeys()).filter((k) => k.startsWith(ITEM_PREFIX));
    if (keys.length === 0) return [];
    const rows = await Storage.multiGet(keys);
    // Parse row by row: one corrupt or half-written row must not throw away the
    // whole queue (and with it every other unsynced survey edit).
    const items: OutboxItem[] = [];
    for (const [key, v] of rows) {
      if (!v) continue;
      try {
        const item = JSON.parse(v) as OutboxItem;
        if (item && typeof item.id === "string" && typeof item.nodeId === "number")
          items.push(item);
      } catch {
        console.warn(`[outbox] skipping unreadable row ${key}`);
      }
    }
    return items;
  },
  put: async (item) => {
    await Storage.setItem(ITEM_PREFIX + item.id, JSON.stringify(item));
  },
  delete: async (id) => {
    await Storage.removeItem(ITEM_PREFIX + id);
  },
  clear: async () => {
    const keys = (await Storage.getAllKeys()).filter((k) => k.startsWith(ITEM_PREFIX));
    if (keys.length) await Storage.multiRemove(keys);
  },
  getMeta: async (key) => {
    const raw = await Storage.getItem(META_PREFIX + key);
    return raw == null ? undefined : JSON.parse(raw);
  },
  setMeta: async (key, value) => {
    if (value === undefined) await Storage.removeItem(META_PREFIX + key);
    else await Storage.setItem(META_PREFIX + key, JSON.stringify(value));
  },
};
