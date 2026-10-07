import { vi } from "vitest";
import { configureCore } from "../../src/configure";
import type { CorePorts, KvPort } from "../../src/ports";
import type { OutboxItem } from "../../src/stores/outbox";

// An in-memory KvPort (stands in for localStorage / expo-sqlite kv-store).
export function makeMemoryKv(): KvPort {
  const store = new Map<string, string>();
  return {
    get: (k) => (store.has(k) ? (store.get(k) as string) : null),
    set: (k, v) => void store.set(k, v),
    remove: (k) => void store.delete(k),
  };
}

// Spy-backed outbox storage so tests can seed hydrate() and assert persistence.
export function makeFakeOutboxStorage() {
  return {
    getAll: vi.fn(async (): Promise<OutboxItem[]> => []),
    put: vi.fn(async (_item: OutboxItem): Promise<void> => {}),
    delete: vi.fn(async (_id: string): Promise<void> => {}),
    clear: vi.fn(async (): Promise<void> => {}),
    getMeta: vi.fn(async (_key: string): Promise<unknown> => undefined),
    setMeta: vi.fn(async (_key: string, _value: unknown): Promise<void> => {}),
  };
}

// Wire fake ports into @rosm/core and hand the spies back to the test.
export function configureTestPorts() {
  const apiFetch = vi.fn();
  const getCurrentPosition = vi.fn();
  const outboxStorage = makeFakeOutboxStorage();
  const kv = makeMemoryKv();
  const ports: CorePorts = {
    api: { apiFetch },
    kv,
    outboxStorage: outboxStorage as unknown as CorePorts["outboxStorage"],
    geolocation: { getCurrentPosition },
  };
  configureCore(ports);
  return { ports, apiFetch, getCurrentPosition, outboxStorage, kv };
}
