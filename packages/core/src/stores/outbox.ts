import { create } from "zustand";
import type { EditAction, EditExtras } from "../schemas";
import { editSummary, todayLocal } from "../editSummary";
import { corePorts } from "../configure";
import { readApiJson, type ApiReply } from "../apiResponse";

// Where a queued edit is in its journey to OSM.
//   pending  — on the device and still going to be sent: inside its undo hold,
//              queued behind an older edit, or waiting to resend after a send
//              that can work later (offline, signed out, server trouble), in
//              which case `error` says what went wrong last time
//   sending  — POST in flight
//   sent     — accepted by OSM
//   failed   — the server refused the edit, or server errors outlasted every
//              resend; only retryAll() sends it again
export type SyncState = "pending" | "sending" | "sent" | "failed";

// Every enqueued edit is held back from flushing for this long, giving the undo
// toast (store/undo.ts) a window in which "undo" is a cheap local cancel — the
// edit never reaches OSM, so no revert changeset is needed.
export const UNDO_WINDOW_MS = 5000;

// A send that hangs (a half-open connection on a dead cell) must not stall the
// queue. Resending after an ambiguous timeout is safe: the server skips a PUT
// that would leave the node's tags unchanged.
const SEND_TIMEOUT_MS = 30_000;

// Resend backoff: 5 s, doubling per attempt, never more than 10 min.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;

// Server-side trouble (5xx, 408, 429, a reply that isn't ours) gets this many
// tries before the edit is marked failed. Being offline or signed out never
// gives up: those clear on their own, and the survey must not be lost meanwhile.
const MAX_SERVER_FAILURES = 8;

// Sent edits stay listed this long (map sync markers, run archives), then
// hydrate() drops them.
const SENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

// One recorded modification. Saved to IndexedDB the instant the user acts, so the
// confetti fires immediately and the edit survives a reload / offline period.
export type OutboxItem = {
  id: string;
  nodeId: number;
  action: EditAction | "broken";
  tagKey: string;
  name?: string; // for the review list
  extras?: EditExtras; // advanced OSM tags (seasonal, note)
  summary: string; // computed locally at enqueue, matches the server's wording
  syncState: SyncState;
  // The surveyor's local YYYY-MM-DD at enqueue, sent as the check_date: the day
  // they stood at the fountain, however late the edit reaches OSM.
  surveyDate?: string;
  attempts?: number; // sends tried so far (counted as each one starts)
  serverFailures?: number; // server-side failures since enqueue or retryAll
  nextAttemptAt?: number; // epoch ms: backoff; only a forced flush sends sooner
  createdAt: string;
  holdUntil?: string; // ISO: flush skips the item until then (undo window)
  error?: string; // why the last send failed (on a pending item: why it waits)
  // Filled once OSM accepts the edit:
  changesetId?: number;
  newVersion?: number; // the version our write made; absent if nothing needed writing
  changesetUrl?: string;
};

// The part of a successful /api/osm/edit reply the outbox keeps. `unchanged`
// means the node already said exactly what the edit would write, so nothing was
// written: usually a resend of an edit whose reply was lost. newVersion is then
// the node's current version, which may not be ours, and changesetId is absent
// if we had none open.
type EditReply = {
  changesetId?: number;
  newVersion?: number;
  changesetUrl?: string;
  unchanged?: boolean;
};

const CHANGESET_META = "changesetId";

// Module-level lock so only one flush loop runs at a time — edits send one by one
// and share a single changeset (the first send opens it, the rest reuse the id).
// A flush requested while the loop runs is folded into it: the loop makes another
// pass, and that caller's promise resolves only once the pass is done.
let flushing = false;
let flushDone: Promise<void> = Promise.resolve();
let rerun = false;
let forceNext = false;

// Single timer that wakes the queue when its head's undo hold or backoff ends,
// so a waiting edit still sends if no other flush trigger (an edit, network,
// foreground) fires first.
let wakeTimer: ReturnType<typeof setTimeout> | undefined;

type EnqueueInput = {
  nodeId: number;
  action: EditAction | "broken";
  tagKey: string;
  name?: string;
  extras?: EditExtras;
};

type OutboxState = {
  items: OutboxItem[];
  changesetId?: number;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  enqueue: (input: EnqueueInput) => OutboxItem;
  flush: (opts?: { force?: boolean }) => Promise<void>;
  retryAll: () => Promise<void>;
  waitUntilSettled: (timeoutMs: number) => Promise<boolean>;
  cancel: (id: string) => boolean;
  remove: (id: string) => void;
  pruneSent: () => Promise<void>;
  setChangeset: (id: number | undefined) => void;
  clear: () => Promise<void>;
};

function uuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// Only a browser reports this; React Native's navigator has no onLine, so on
// device every send is simply attempted and a failure backs off.
const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;

// The queue is strictly first in, first out: an edit never overtakes an older
// unsent one. Two edits to the same node must reach OSM in the order they were
// made (the latest survey wins), and while the oldest can't get through
// (offline, signed out, OSM down) the ones behind it wouldn't either.
const head = (items: OutboxItem[]) => items.find((i) => i.syncState === "pending");

// When an edit may next be sent: after its undo hold and, unless the flush is
// forced, after its backoff.
function dueAt(item: OutboxItem, force: boolean): number {
  const hold = item.holdUntil ? Date.parse(item.holdUntil) || 0 : 0;
  return Math.max(hold, force ? 0 : (item.nextAttemptAt ?? 0));
}

// Jittered so phones that lost the server together don't all resend in lockstep.
function backoffMs(attempts: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(attempts - 1, 0), RETRY_MAX_MS);
  return Math.round(base * (0.8 + 0.2 * Math.random()));
}

// How the queue treats a reply that wasn't a success:
//   wait  — the user must sign in (401/403): resend with backoff for as long as
//           it takes; signing in forces a resend
//   retry — server or OSM trouble that may pass, or a reply that isn't from our
//           API at all (captive portal, platform error page): resend with
//           backoff, up to MAX_SERVER_FAILURES times
//   fail  — the request itself was refused; sending it again can't help
function classify(reply: Extract<ApiReply<unknown>, { ok: false }>): "wait" | "retry" | "fail" {
  if (reply.status === 401 || reply.status === 403) return "wait";
  // readApiJson leaves `body` undefined only when the reply wasn't JSON.
  if (reply.body === undefined) return "retry";
  return reply.retryable ? "retry" : "fail";
}

export const useOutbox = create<OutboxState>((set, get, store) => {
  // Persist a single item to IndexedDB and patch it into the in-memory list. An
  // item no longer in memory was removed or cleared while its send was in
  // flight; writing it back would resurrect it on the next launch.
  const persist = (item: OutboxItem) => {
    if (!get().items.some((i) => i.id === item.id)) return;
    set((s) => ({ items: s.items.map((i) => (i.id === item.id ? item : i)) }));
    corePorts().outboxStorage.put(item);
  };

  // Put an edit back in line, to resend once its backoff has passed.
  const resendLater = (item: OutboxItem, error: string) =>
    persist({
      ...item,
      syncState: "pending",
      error,
      nextAttemptAt: Date.now() + backoffMs(item.attempts ?? 1),
    });

  // One POST for the queue's head. Every outcome lands in the item's state:
  // sent, failed, or pending again with a backoff. Never throws.
  const send = async (item: OutboxItem) => {
    // Counted before the request leaves: if the app dies mid-send, OSM may
    // already have the edit, and cancel() must stop treating it as unsent.
    const sending: OutboxItem = {
      ...item,
      syncState: "sending",
      attempts: (item.attempts ?? 0) + 1,
    };
    persist(sending);

    let reply: ApiReply<EditReply | null>;
    try {
      const r = await corePorts().api.apiFetch(
        "/api/osm/edit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nodeId: item.nodeId,
            action: item.action,
            tagKey: item.tagKey,
            extras: item.extras,
            surveyDate: item.surveyDate,
            changesetId: get().changesetId,
          }),
        },
        { timeoutMs: SEND_TIMEOUT_MS },
      );
      reply = await readApiJson<EditReply | null>(r, `Edit failed (HTTP ${r.status})`);
    } catch (e) {
      // No reply at all: offline, timed out, connection dropped. Any rejection
      // counts, not only isTransportError's TypeError: on device, expo/fetch
      // rejects with its own FetchError.
      resendLater(sending, e instanceof Error ? e.message : String(e));
      return;
    }

    // Every success carries newVersion, an unchanged one included.
    if (reply.ok && typeof reply.data?.newVersion === "number") {
      const { changesetId, changesetUrl, newVersion, unchanged } = reply.data;
      // An edit that wrote nothing may come back without a changeset; the one
      // we hold stays open for the next edit.
      if (typeof changesetId === "number") get().setChangeset(changesetId);
      persist({
        ...sending,
        syncState: "sent",
        changesetId,
        changesetUrl,
        newVersion: unchanged ? undefined : newVersion,
        error: undefined,
        nextAttemptAt: undefined,
      });
      return;
    }

    // A 2xx without our body came from something in between, not the API.
    const kind = reply.ok ? "retry" : classify(reply);
    const error = reply.ok ? "Unexpected reply from the server" : reply.message;
    const serverFailures = (sending.serverFailures ?? 0) + (kind === "retry" ? 1 : 0);
    if (kind === "fail" || serverFailures >= MAX_SERVER_FAILURES) {
      persist({ ...sending, syncState: "failed", serverFailures, error, nextAttemptAt: undefined });
    } else {
      resendLater({ ...sending, serverFailures }, error);
    }
  };

  // Send from the head of the queue until it empties or the head has to wait.
  // The head is re-read after every send, so edits enqueued or released from
  // their hold meanwhile go out in the same loop.
  const drain = async () => {
    flushing = true;
    try {
      do {
        rerun = false;
        const force = forceNext;
        forceNext = false;
        for (;;) {
          const next = head(get().items);
          if (!next || dueAt(next, force) > Date.now() || offline()) break;
          await send(next);
          // Still pending means it is backing off, and everything behind it waits.
          if (get().items.find((i) => i.id === next.id)?.syncState === "pending") break;
        }
      } while (rerun);
    } finally {
      flushing = false;
      schedule();
    }
  };

  // Re-arm the wake timer for when the queue's head becomes due.
  const schedule = () => {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
    const next = head(get().items);
    if (!next) return;
    const wait = dueAt(next, false) - Date.now();
    // Due already but offline: the reconnect trigger resumes the queue, and a
    // timer here would only spin.
    if (wait <= 0 && offline()) return;
    // 50 ms past due so the woken flush finds the item ready. Capped at the
    // longest backoff so a clock change can't overflow setTimeout.
    const delay = Math.min(Math.max(wait, 0) + 50, RETRY_MAX_MS);
    wakeTimer = setTimeout(() => void get().flush(), delay);
  };

  return {
    items: [],
    changesetId: undefined,
    hydrated: false,

    // Load the queue from IndexedDB on app start. Any "sending" item is from a
    // session that was interrupted mid-POST — reset it to pending so it retries.
    // Sent items past their retention are dropped. Never throws: a queue that
    // fails to load must not stop this session's edits from sending.
    hydrate: async () => {
      if (get().hydrated) return;
      let stored: OutboxItem[] = [];
      let changesetId: number | undefined;
      try {
        [stored, changesetId] = await Promise.all([
          corePorts().outboxStorage.getAll(),
          corePorts().outboxStorage.getMeta<number>(CHANGESET_META),
        ]);
      } catch {
        // Unreadable storage: carry on with what is in memory.
      }
      const cutoff = Date.now() - SENT_RETENTION_MS;
      const byId = new Map<string, OutboxItem>();
      for (const row of stored) {
        if (row.syncState === "sent" && Date.parse(row.createdAt) < cutoff) {
          corePorts().outboxStorage.delete(row.id);
          continue;
        }
        const item = row.syncState === "sending" ? { ...row, syncState: "pending" as const } : row;
        if (item !== row) corePorts().outboxStorage.put(item);
        byId.set(item.id, item);
      }
      // An edit recorded before the load finished is already in memory: keep it.
      for (const item of get().items) byId.set(item.id, item);
      // Plain comparison, not localeCompare: ISO timestamps sort as strings, and
      // a malformed row must not make the sort throw.
      const items = [...byId.values()].sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
      set({ items, changesetId: get().changesetId ?? changesetId, hydrated: true });
    },

    // Record an edit locally. Returns the item so the caller can fire confetti and
    // reflect it in the UI immediately, before the network is ever touched.
    enqueue: (input) => {
      const surveyDate = todayLocal();
      const item: OutboxItem = {
        id: uuid(),
        nodeId: input.nodeId,
        action: input.action,
        tagKey: input.tagKey,
        name: input.name,
        extras: input.extras,
        summary: editSummary(input.action, input.tagKey, surveyDate, input.extras),
        syncState: "pending",
        surveyDate,
        attempts: 0,
        createdAt: new Date().toISOString(),
        holdUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString(),
      };
      set((s) => ({ items: [...s.items, item] }));
      corePorts().outboxStorage.put(item);
      return item;
    },

    // Send pending edits to OSM, oldest first, sharing one changeset. An edit
    // waits out its undo hold and its backoff; `force` (reconnect, foreground,
    // sign-in) skips the backoff, never the hold. Failed edits are left to
    // retryAll. Afterwards the wake timer is re-armed for whatever still waits.
    flush: (opts) => {
      if (opts?.force) forceNext = true;
      if (flushing) {
        rerun = true;
        return flushDone;
      }
      flushDone = drain();
      return flushDone;
    },

    // "Retry all missed sends": re-arm every failed edit, with a fresh allowance
    // of server failures, and flush again. A retry is an explicit resend, so any
    // leftover undo hold or backoff is dropped.
    retryAll: async () => {
      const failed = get().items.filter((i) => i.syncState === "failed");
      failed.forEach((i) =>
        persist({
          ...i,
          syncState: "pending",
          error: undefined,
          holdUntil: undefined,
          nextAttemptAt: undefined,
          serverFailures: 0,
        }),
      );
      await get().flush({ force: true });
    },

    // Resolves true once nothing is pending or sending, false if that takes more
    // than timeoutMs. It only watches; pair it with flush({ force: true }).
    waitUntilSettled: (timeoutMs) =>
      new Promise<boolean>((resolve) => {
        const settled = () =>
          !get().items.some((i) => i.syncState === "pending" || i.syncState === "sending");
        if (settled()) {
          resolve(true);
          return;
        }
        const finish = (result: boolean) => {
          clearTimeout(timer);
          unsubscribe();
          resolve(result);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        const unsubscribe = store.subscribe(() => {
          if (settled()) finish(true);
        });
      }),

    // Undo an edit that hasn't left the device: only a pending item that was
    // never sent can be cancelled. Once a send has been tried, even one that
    // timed out, OSM may have it, so it must be reverted through OSM instead —
    // see store/undo.ts.
    cancel: (id) => {
      const item = get().items.find((i) => i.id === id);
      if (!item || item.syncState !== "pending" || (item.attempts ?? 0) > 0) return false;
      get().remove(id);
      return true;
    },

    // Drop an item from the queue + IndexedDB unconditionally (used after a
    // successful OSM revert, so the record reads as if the tap never happened).
    remove: (id) => {
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
      corePorts().outboxStorage.delete(id);
    },

    // Drop the edits OSM has accepted, from memory and storage. Everything not
    // yet sent stays queued, so this is the safe way to tidy up after a run.
    pruneSent: async () => {
      const sent = get().items.filter((i) => i.syncState === "sent");
      if (sent.length === 0) return;
      const ids = new Set(sent.map((i) => i.id));
      set((s) => ({ items: s.items.filter((i) => !ids.has(i.id)) }));
      await Promise.all(sent.map((i) => corePorts().outboxStorage.delete(i.id)));
    },

    setChangeset: (id) => {
      set({ changesetId: id });
      corePorts().outboxStorage.setMeta(CHANGESET_META, id);
    },

    // Destructive: wipe the whole queue and the changeset, unsent edits
    // included. Only for an explicit "discard"; pruneSent() is the routine tidy-up.
    clear: async () => {
      set({ items: [], changesetId: undefined });
      await corePorts().outboxStorage.clear();
      await corePorts().outboxStorage.setMeta(CHANGESET_META, undefined);
    },
  };
});

// Derived counts for the review UI.
export function outboxCounts(items: OutboxItem[]) {
  let sent = 0,
    pending = 0,
    sending = 0,
    failed = 0;
  for (const i of items) {
    if (i.syncState === "sent") sent++;
    else if (i.syncState === "failed") failed++;
    else if (i.syncState === "sending") sending++;
    else pending++;
  }
  // "unsent" = anything not yet confirmed by OSM.
  return {
    sent,
    pending,
    sending,
    failed,
    unsent: pending + sending + failed,
    total: items.length,
  };
}
