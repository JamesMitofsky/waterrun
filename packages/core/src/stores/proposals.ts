import { create } from "zustand";
import type { EditAction, EditExtras, TagFilter } from "../schemas";
import type { UploadCreate, UploadEdit } from "../uploadRequest";
import { todayLocal } from "../editSummary";
import { corePorts } from "../configure";
import type { KvPort } from "../ports";
import { callApi, postJson } from "../apiCall";
import { patchArchivedRoute } from "../routeArchive";

// A run's updates, held on the phone until the surveyor has reviewed them and
// written to OSM together, as one changeset in one atomic diff upload. Nothing
// here talks to OSM until submit().
//
// Each proposal is one run (keyed by its routeId) and is written to the
// synchronous kv store on every change, so an update is on disk before the tap
// that made it returns: a crash, a force-quit or a flat battery can't lose it,
// and a run that never reached its review is picked back up at the next launch.
//
// Life of a proposal:
//   drafting   — the run is under way and updates are being recorded
//   review     — the run has ended; waiting for the surveyor to check and send
//   submitting — the upload is in flight
//   submitted  — OSM has it; kept for the run's history (changeset link)

export type ProposedEdit = {
  kind: "edit";
  key: string; // editKey(nodeId): one edit per point, a re-survey replaces it
  nodeId: number;
  action: EditAction;
  tagKey: string;
  name?: string;
  extras?: EditExtras;
  // Where the point is and what OSM said about it when surveyed, for the
  // review screen only (the server reads the node fresh before writing).
  point?: { lat: number; lon: number; tags: Record<string, string> };
  // The surveyor's local YYYY-MM-DD when recorded: the day they stood there,
  // however late the run is sent.
  surveyDate: string;
  updatedAt: string;
};

export type ProposedCreate = {
  kind: "create";
  key: string; // createKey(tempId)
  // A negative id, OSM's placeholder for an element the upload creates, and
  // the id the run uses for the point until OSM assigns a real one.
  tempId: number;
  lat: number;
  lon: number;
  tag: TagFilter;
  name?: string;
  extras?: EditExtras;
  surveyDate: string;
  updatedAt: string;
};

export type ProposedItem = ProposedEdit | ProposedCreate;

export type ProposalState = "drafting" | "review" | "submitting" | "submitted";

export type ItemProblem = { key: string; error: string };

export type RunProposal = {
  routeId: string;
  createdAt: string;
  updatedAt: string;
  state: ProposalState;
  items: ProposedItem[];
  // The changeset opened for this submission. Stored before the upload is
  // sent, so a resend after a lost reply goes to the same changeset, where the
  // server can tell the first try already landed.
  changesetId?: number;
  problems?: ItemProblem[]; // items the server refused; nothing was written
  error?: string; // why the last submit failed, for the review screen
  result?: { changesetId: number; changesetUrl: string; submittedAt: string };
};

export type SubmitOutcome =
  | { ok: true; changesetId: number; changesetUrl: string }
  | {
      ok: false;
      reason: "signed-out" | "problems" | "failed" | "busy" | "nothing";
      message: string;
    };

export const editKey = (nodeId: number) => `n:${nodeId}`;
export const createKey = (tempId: number) => `c:${tempId}`;

const INDEX_KEY = "water-run:proposals:index";
const proposalKey = (routeId: string) => `water-run:proposal:${routeId}`;

const OPEN_TIMEOUT_MS = 30_000;
// Above the server's own budget for an upload (node reads, the upload, its
// close). Giving up early costs nothing: a resend is answered from the
// changeset without writing twice.
const UPLOAD_TIMEOUT_MS = 150_000;

const SIGNED_OUT = "Sign in to send your updates to the map.";

// Submits in flight, by routeId. In memory only: a submit cut off by the app
// closing revives as "review" and is simply sent again.
const inFlight = new Set<string>();

// -- Storage --------------------------------------------------------------

function kv(): KvPort | null {
  try {
    return corePorts().kv;
  } catch {
    return null;
  }
}

function parse(raw: string | null): unknown {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isProposal(v: unknown): v is RunProposal {
  const p = v as RunProposal | null;
  return !!p && typeof p.routeId === "string" && p.routeId !== "" && Array.isArray(p.items);
}

function readIndex(store: KvPort): string[] {
  const list = parse(store.get(INDEX_KEY));
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
}

function readProposal(store: KvPort, routeId: string): RunProposal | undefined {
  const p = parse(store.get(proposalKey(routeId)));
  // A corrupt row is skipped, not thrown: it must not take the other runs'
  // updates down with it.
  return isProposal(p) && p.routeId === routeId ? p : undefined;
}

// Write one proposal, then list it in the index. The proposal goes first, so
// the index never lists one that isn't stored. Returns whether it's on disk.
function writeProposal(p: RunProposal): boolean {
  const store = kv();
  if (!store) return false;
  try {
    store.set(proposalKey(p.routeId), JSON.stringify(p));
    const index = readIndex(store);
    if (!index.includes(p.routeId)) store.set(INDEX_KEY, JSON.stringify([...index, p.routeId]));
    return true;
  } catch (e) {
    console.warn("[proposals] couldn't save", e);
    return false;
  }
}

function deleteProposal(routeId: string): void {
  const store = kv();
  if (!store) return;
  try {
    store.remove(proposalKey(routeId));
    store.set(INDEX_KEY, JSON.stringify(readIndex(store).filter((id) => id !== routeId)));
  } catch {
    // Left behind: an empty proposal is harmless and dropped at the next launch.
  }
}

// -- Pure helpers ---------------------------------------------------------

const now = () => new Date().toISOString();

// Bring a stored proposal up to date at launch. A submit cut off by the app
// closing goes back to review, keeping its changeset (a resend is answered
// from it). A run still drafting whose run is no longer the active one ended
// without reaching its review (the app was killed, or its archive was lost),
// so its updates go to review rather than being stranded.
function revive(p: RunProposal, activeRouteId: string | null | undefined): RunProposal {
  if (p.state === "submitting") return { ...p, state: "review" };
  if (p.state === "drafting" && activeRouteId !== undefined && p.routeId !== activeRouteId) {
    return { ...p, state: "review" };
  }
  return p;
}

const editable = (p: RunProposal | undefined) =>
  !p || p.state === "drafting" || p.state === "review";

function nextTempId(items: ProposedItem[]): number {
  let min = -1;
  for (const i of items) if (i.kind === "create" && i.tempId < min) min = i.tempId;
  // -1 is the add sheet's own placeholder, so the first real one is -2.
  return min - 1;
}

// The proposals waiting for the surveyor to send them, oldest first.
export function waitingForReview(byRoute: Record<string, RunProposal>): RunProposal[] {
  return Object.values(byRoute)
    .filter((p) => (p.state === "review" || p.state === "submitting") && p.items.length > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// How many updates are held on the phone, not yet sent.
export function heldCount(byRoute: Record<string, RunProposal>): number {
  let n = 0;
  for (const p of Object.values(byRoute)) if (p.state !== "submitted") n += p.items.length;
  return n;
}

export function itemFor(p: RunProposal | undefined, id: number | string): ProposedItem | undefined {
  if (!p) return undefined;
  const n = Number(id);
  return p.items.find((i) => (i.kind === "edit" ? i.nodeId === n : i.tempId === n));
}

export function problemFor(p: RunProposal | undefined, key: string): string | undefined {
  return p?.problems?.find((x) => x.key === key)?.error;
}

// What the server is sent. Names and timestamps stay on the phone.
export function uploadBody(p: RunProposal) {
  const edits: UploadEdit[] = [];
  const creates: UploadCreate[] = [];
  for (const i of p.items) {
    if (i.kind === "edit") {
      edits.push({
        key: i.key,
        nodeId: i.nodeId,
        action: i.action,
        tagKey: i.tagKey,
        extras: i.extras,
        surveyDate: i.surveyDate,
      });
    } else {
      creates.push({
        key: i.key,
        tempId: i.tempId,
        lat: i.lat,
        lon: i.lon,
        tag: i.tag,
        extras: i.extras,
        surveyDate: i.surveyDate,
      });
    }
  }
  return { changesetId: p.changesetId, edits, creates };
}

// The parts of the server's replies the store reads.
type OpenReply = { changesetId?: unknown };
type UploadReply = {
  changesetId?: unknown;
  changesetUrl?: unknown;
  written?: { key?: unknown; nodeId?: unknown }[];
};
type FailureBody = { changesetId?: unknown; problems?: unknown };

function problemsOf(body: unknown): ItemProblem[] | undefined {
  const list = (body as FailureBody | undefined)?.problems;
  if (!Array.isArray(list)) return undefined;
  const out = list.filter(
    (x): x is ItemProblem => !!x && typeof x.key === "string" && typeof x.error === "string",
  );
  return out.length ? out : undefined;
}

const positiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

// -- Store ----------------------------------------------------------------

type RecordInput = {
  nodeId: number;
  action: EditAction;
  tagKey: string;
  name?: string;
  extras?: EditExtras;
  point?: ProposedEdit["point"];
};

type CreateInput = { lat: number; lon: number; tag: TagFilter; name?: string; extras?: EditExtras };

type ProposalsState = {
  byRoute: Record<string, RunProposal>;
  hydrated: boolean;
  // Load every stored proposal. `activeRouteId` is the run still under way
  // (runLifecycle's getActiveRunId): pass it once per launch so a run that
  // ended without its review is moved to review. Omitted, nothing is moved.
  hydrate: (activeRouteId?: string | null) => void;
  // Record (or replace) a point's update. `saved` says whether it reached the
  // phone's storage; `previous` is what it replaced, for Undo.
  record: (
    routeId: string,
    input: RecordInput,
  ) => { saved: boolean; item?: ProposedEdit; previous?: ProposedItem };
  addCreate: (routeId: string, input: CreateInput) => { saved: boolean; item?: ProposedCreate };
  // Put an item back as it was (Undo).
  put: (routeId: string, item: ProposedItem) => boolean;
  update: (
    routeId: string,
    key: string,
    patch: { action?: EditAction; extras?: EditExtras },
  ) => boolean;
  remove: (routeId: string, key: string) => boolean;
  // The run has ended. Returns whether it left anything to review; a run
  // with no updates has its empty proposal dropped.
  toReview: (routeId: string) => boolean;
  submit: (routeId: string) => Promise<SubmitOutcome>;
  // Throw a run's held updates away. Destructive; only for an explicit discard.
  discard: (routeId: string) => void;
};

export const useProposals = create<ProposalsState>((set, get) => {
  const ensure = () => {
    if (!get().hydrated) get().hydrate();
  };

  const load = (routeId: string): RunProposal | undefined => {
    ensure();
    return get().byRoute[routeId];
  };

  // Keep a proposal in memory and on disk. Returns whether it's on disk.
  const save = (p: RunProposal): boolean => {
    set((s) => ({ byRoute: { ...s.byRoute, [p.routeId]: p } }));
    return writeProposal(p);
  };

  const fresh = (routeId: string): RunProposal => {
    const t = now();
    return { routeId, createdAt: t, updatedAt: t, state: "drafting", items: [] };
  };

  // Replace (or add) one item. Editing clears any problem the server had with
  // it, since the problem may no longer apply.
  const withItem = (p: RunProposal, item: ProposedItem): RunProposal => {
    const at = p.items.findIndex((i) => i.key === item.key);
    const items = at === -1 ? [...p.items, item] : p.items.map((i, n) => (n === at ? item : i));
    return {
      ...p,
      items,
      updatedAt: now(),
      problems: p.problems?.filter((x) => x.key !== item.key),
    };
  };

  // Keep the archived run in step with a change made in review, so the run's
  // history says what was actually sent. During the run the run store owns
  // the archive and writes it on every record.
  const reflectInArchive = (p: RunProposal, item: ProposedItem, removed: boolean) => {
    if (p.state === "drafting") return;
    patchArchivedRoute(p.routeId, (plan) => {
      if (item.kind === "edit") {
        const status = removed ? "skipped" : item.action;
        if (!plan.stops.some((s) => s.id === item.nodeId && s.status !== status)) return plan;
        return {
          ...plan,
          stops: plan.stops.map((s) => (s.id === item.nodeId ? { ...s, status } : s)),
        };
      }
      if (!removed) return plan;
      return { ...plan, added: plan.added.filter((f) => f.id !== item.tempId) };
    });
  };

  // The upload took: stamp the archived run with its changeset and the ids OSM
  // gave the new points.
  const reflectSubmitted = (
    p: RunProposal,
    changesetId: number,
    written: UploadReply["written"],
  ) => {
    const created = new Map<number, number>();
    for (const w of written ?? []) {
      const item = p.items.find((i) => i.key === w.key);
      if (item?.kind === "create" && positiveInt(w.nodeId)) created.set(item.tempId, w.nodeId);
    }
    patchArchivedRoute(p.routeId, (plan) => ({
      ...plan,
      changesetId,
      added: plan.added.map((f) => {
        const id = created.get(f.id);
        return id === undefined ? f : { ...f, id };
      }),
    }));
  };

  // Back to review after a failed submit, with what the screen should say.
  const failed = (
    p: RunProposal,
    outcome: Extract<SubmitOutcome, { ok: false }>,
    extra: Partial<RunProposal> = {},
  ): SubmitOutcome => {
    save({ ...p, ...extra, state: "review", error: outcome.message, updatedAt: now() });
    return outcome;
  };

  return {
    byRoute: {},
    hydrated: false,

    hydrate: (activeRouteId) => {
      const store = kv();
      const loaded: Record<string, RunProposal> = {};
      if (store) {
        let index: string[] = [];
        try {
          index = readIndex(store);
        } catch {
          // Unreadable index: start empty rather than fail the launch.
        }
        for (const routeId of index) {
          let stored: RunProposal | undefined;
          try {
            stored = readProposal(store, routeId);
          } catch {
            stored = undefined;
          }
          if (!stored) continue;
          const p = revive(stored, activeRouteId);
          // Nothing recorded and not the run under way: nothing to keep.
          if (p.items.length === 0 && p.state !== "submitted" && p.routeId !== activeRouteId) {
            deleteProposal(routeId);
            continue;
          }
          if (p !== stored) writeProposal(p);
          loaded[routeId] = p;
        }
      }
      // A proposal changed before the load (an update recorded at launch) is
      // newer than its stored copy: keep it.
      set((s) => ({ byRoute: { ...loaded, ...s.byRoute }, hydrated: true }));
      // A later call with the active run is still the launch's: promote.
      if (activeRouteId !== undefined) {
        for (const p of Object.values(get().byRoute)) {
          const next = revive(p, activeRouteId);
          if (next !== p) save(next);
        }
      }
    },

    record: (routeId, input) => {
      const p = load(routeId) ?? fresh(routeId);
      if (!editable(p)) return { saved: false };
      const key = editKey(input.nodeId);
      const previous = p.items.find((i) => i.key === key);
      const item: ProposedEdit = {
        kind: "edit",
        key,
        nodeId: input.nodeId,
        action: input.action,
        tagKey: input.tagKey,
        name: input.name,
        extras: input.extras,
        point: input.point,
        surveyDate: todayLocal(),
        updatedAt: now(),
      };
      const next = withItem(p, item);
      const saved = save(next);
      reflectInArchive(next, item, false);
      return { saved, item, previous };
    },

    addCreate: (routeId, input) => {
      const p = load(routeId) ?? fresh(routeId);
      if (!editable(p)) return { saved: false };
      const tempId = nextTempId(p.items);
      const item: ProposedCreate = {
        kind: "create",
        key: createKey(tempId),
        tempId,
        lat: input.lat,
        lon: input.lon,
        tag: input.tag,
        name: input.name,
        extras: input.extras,
        surveyDate: todayLocal(),
        updatedAt: now(),
      };
      return { saved: save(withItem(p, item)), item };
    },

    put: (routeId, item) => {
      const p = load(routeId);
      if (!p || !editable(p)) return false;
      const next = withItem(p, item);
      const saved = save(next);
      reflectInArchive(next, item, false);
      return saved;
    },

    update: (routeId, key, patch) => {
      const p = load(routeId);
      const item = p?.items.find((i) => i.key === key);
      if (!p || !item || !editable(p)) return false;
      const changed: ProposedItem =
        item.kind === "edit"
          ? {
              ...item,
              action: patch.action ?? item.action,
              extras: "extras" in patch ? patch.extras : item.extras,
              updatedAt: now(),
            }
          : { ...item, extras: "extras" in patch ? patch.extras : item.extras, updatedAt: now() };
      const next = withItem(p, changed);
      const saved = save(next);
      reflectInArchive(next, changed, false);
      return saved;
    },

    remove: (routeId, key) => {
      const p = load(routeId);
      const item = p?.items.find((i) => i.key === key);
      if (!p || !item || !editable(p)) return false;
      const next: RunProposal = {
        ...p,
        items: p.items.filter((i) => i.key !== key),
        problems: p.problems?.filter((x) => x.key !== key),
        updatedAt: now(),
      };
      const saved = save(next);
      reflectInArchive(next, item, true);
      return saved;
    },

    toReview: (routeId) => {
      const p = load(routeId);
      if (!p) return false;
      if (p.items.length === 0 && p.state !== "submitted") {
        set((s) => {
          const { [routeId]: _gone, ...rest } = s.byRoute;
          return { byRoute: rest };
        });
        deleteProposal(routeId);
        return false;
      }
      if (p.state === "drafting") save({ ...p, state: "review", updatedAt: now() });
      return p.state !== "submitted";
    },

    submit: async (routeId) => {
      let p = load(routeId);
      if (!p || p.items.length === 0 || p.state === "submitted") {
        return { ok: false, reason: "nothing", message: "There's nothing to send." };
      }
      if (inFlight.has(routeId)) {
        return { ok: false, reason: "busy", message: "Already sending." };
      }
      inFlight.add(routeId);
      try {
        p = { ...p, state: "submitting", error: undefined, updatedAt: now() };
        save(p);

        // 1. The changeset this submission goes into, stored before anything
        //    is uploaded to it.
        if (p.changesetId === undefined) {
          const opened = await callApi<OpenReply>(
            "/api/osm/changeset",
            postJson({}),
            OPEN_TIMEOUT_MS,
            "Couldn't start sending your updates. Please try again.",
          );
          if (!opened.ok) {
            const signedOut = opened.status === 401;
            return failed(p, {
              ok: false,
              reason: signedOut ? "signed-out" : "failed",
              message: signedOut ? SIGNED_OUT : opened.message,
            });
          }
          if (!positiveInt(opened.data?.changesetId)) {
            return failed(p, {
              ok: false,
              reason: "failed",
              message: "The server sent an unexpected reply. Please try again.",
            });
          }
          p = { ...p, changesetId: opened.data.changesetId };
          save(p);
        }

        // 2. Every update, in one upload.
        const reply = await callApi<UploadReply>(
          "/api/osm/upload",
          postJson(uploadBody(p)),
          UPLOAD_TIMEOUT_MS,
          "Couldn't send your updates. Please try again.",
        );

        if (!reply.ok) {
          // The server may have moved the submission to a fresh changeset
          // before failing; later tries go there.
          const moved = (reply.body as FailureBody | undefined)?.changesetId;
          const changesetId = positiveInt(moved) ? moved : p.changesetId;
          const problems = problemsOf(reply.body);
          if (problems) {
            return failed(
              p,
              {
                ok: false,
                reason: "problems",
                message:
                  problems.length === 1
                    ? "One update couldn't be sent. Remove or change it, then try again."
                    : `${problems.length} updates couldn't be sent. Remove or change them, then try again.`,
              },
              { changesetId, problems },
            );
          }
          const signedOut = reply.status === 401;
          return failed(
            p,
            {
              ok: false,
              reason: signedOut ? "signed-out" : "failed",
              message: signedOut ? SIGNED_OUT : reply.message,
            },
            { changesetId },
          );
        }

        const { changesetId, changesetUrl, written } = reply.data ?? {};
        if (!positiveInt(changesetId) || typeof changesetUrl !== "string") {
          // Something answered that isn't our API. Whether the upload landed
          // is unknown, so the next try asks the changeset.
          return failed(p, {
            ok: false,
            reason: "failed",
            message: "The server sent an unexpected reply. Please try again.",
          });
        }
        const submitted: RunProposal = {
          ...p,
          state: "submitted",
          changesetId,
          problems: undefined,
          error: undefined,
          result: { changesetId, changesetUrl, submittedAt: now() },
          updatedAt: now(),
        };
        save(submitted);
        reflectSubmitted(submitted, changesetId, written);
        return { ok: true, changesetId, changesetUrl };
      } catch (e) {
        // callApi rejects only for a bug, not the network; still, the
        // proposal must not stay stuck in "submitting".
        console.warn("[proposals] submit failed", e);
        return failed(p, {
          ok: false,
          reason: "failed",
          message: "Something went wrong while sending. Your updates are still on this phone.",
        });
      } finally {
        inFlight.delete(routeId);
      }
    },

    discard: (routeId) => {
      if (inFlight.has(routeId)) return;
      set((s) => {
        const { [routeId]: _gone, ...rest } = s.byRoute;
        return { byRoute: rest };
      });
      deleteProposal(routeId);
    },
  };
});
