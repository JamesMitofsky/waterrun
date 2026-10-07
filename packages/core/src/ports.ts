// Platform capabilities that each app injects at startup. The stores and other
// core modules call these through the registry in ./configure.ts, so nothing in
// @rosm/core reaches for a browser or Expo API directly.
//
// Only the ports the core runtime actually calls live in CorePorts. The rest are
// contract types each app implements and consumes in its own UI layer, kept here
// so the web and mobile adapters can `satisfies`-check against one definition.
import type { OutboxItem } from "./stores/outbox";

export type GeoPoint = {
  lat: number;
  lon: number;
  heading: number | null; // travel direction in degrees, present only while moving
  accuracy?: number;
};

export type GeoWatch = { clear: () => void };

// -- Ports the core runtime calls (the injected registry) --------------------

export type ApiFetchOptions = {
  // Hard ceiling on the whole request. On expiry the request is aborted and the
  // call rejects with ApiTimeoutError (./apiResponse). Without one, a half-open
  // connection can hang for many minutes on a phone (Android's OkHttp has no
  // read timeout by default). Omit to wait indefinitely.
  timeoutMs?: number;
};

export type ApiPort = {
  // Talk to the Water Run backend (the Astro /api endpoints). Web sends the
  // httpOnly OSM cookie (same origin); mobile prefixes an absolute base and
  // attaches the OSM bearer token.
  apiFetch: (path: string, init?: RequestInit, opts?: ApiFetchOptions) => Promise<Response>;
};

// Small synchronous key/value store (route archive + planner draft). localStorage
// on web, expo-sqlite/kv-store's sync API on mobile.
export type KvPort = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

// The offline outbox: one record per queued edit plus a tiny meta kv. IndexedDB
// on web, expo-sqlite on mobile.
export type OutboxStoragePort = {
  getAll: () => Promise<OutboxItem[]>;
  put: (item: OutboxItem) => Promise<void>;
  delete: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  getMeta: <T>(key: string) => Promise<T | undefined>;
  setMeta: <T>(key: string, value: T | undefined) => Promise<void>;
};

export type GeolocationPort = {
  getCurrentPosition: (opts?: { highAccuracy?: boolean }) => Promise<GeoPoint>;
};

export type CorePorts = {
  api: ApiPort;
  kv: KvPort;
  outboxStorage: OutboxStoragePort;
  geolocation: GeolocationPort;
};

// -- Contract-only ports (implemented and consumed inside each app) ----------

export type GeolocationWatchPort = {
  // Live run tracking. Web watches foreground; mobile runs a background task.
  watchRunPosition: (
    onPoint: (p: GeoPoint) => void,
    onError: (msg: string) => void,
  ) => Promise<GeoWatch>;
};

export type HapticsPort = { success: () => void };

export type SharePort = {
  canShare: () => boolean;
  share: (opts: { title: string; text: string; url: string }) => Promise<void>;
};

export type KeepAwakePort = { keepAwake: () => void; allowSleep: () => void };

export type NotifyPort = {
  ensurePermission: () => Promise<boolean>;
  proximity: (name: string, meters: number) => void;
  runComplete: (count: number) => void;
  syncPending: (count: number) => void;
};

export type RunActivityState = {
  nextName: string;
  distanceToNext: number;
  stopsRemaining: number;
  totalStops: number;
};

export type LiveActivityPort = {
  start: (s: RunActivityState) => void;
  update: (s: RunActivityState) => void;
  end: () => void;
};

export type CelebratePort = { celebratePoint: () => void };
