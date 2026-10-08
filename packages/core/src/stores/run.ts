import { create } from "zustand";
import type { Fountain } from "../schemas";
import type { Pt } from "../geo";
import type { Turn } from "../brouter";

export type StopStatus = "pending" | "confirm" | "broken" | "out_of_order" | "removed" | "skipped";

export type RunStop = Fountain & { status: StopStatus };

export type RunPlan = {
  start: Pt;
  loop: boolean;
  tagKey: string;
  tagValue: string; // pair with tagKey to tag newly-added nodes (e.g. drinking_water)
  stops: RunStop[];
  vias: Pt[]; // mandatory pass-through points (not survey targets)
  pool: Fountain[]; // all nearby fountains, incl. ones off the route — shown dimmed
  added: Fountain[]; // new nodes created on the fly during the run
  routeCoords: [number, number][]; // [lon,lat] from BRouter
  distanceM: number;
  turns: Turn[]; // precomputed maneuvers along the route, for the live HUD
};

// A run as the archive keeps it, ready to pick back up. Pass the routeId it was
// archived under: without one, hydrate starts a new id and the run's next
// archive becomes a second entry.
export type SavedRun = Omit<RunPlan, "pool"> & {
  pool?: Fountain[]; // optional: runs/archives persisted before pool existed
  index?: number;
  changesetId?: number;
  routeId?: string;
};

type RunState = RunPlan & {
  index: number;
  changesetId?: number;
  routeId: string; // stable id for this run, used to key the localStorage archive
  hasPlan: boolean;
  setPlan: (p: RunPlan) => void;
  hydrate: (p: SavedRun) => void;
  setStatus: (id: number, status: StopStatus) => void;
  setIndex: (i: number) => void;
  setChangeset: (id: number) => void;
  addNode: (f: Fountain) => void;
  removeNode: (id: number) => void;
  reset: () => void;
};

const empty: RunPlan = {
  start: { lat: 0, lon: 0 },
  loop: true,
  tagKey: "amenity",
  tagValue: "drinking_water",
  stops: [],
  vias: [],
  pool: [],
  added: [],
  routeCoords: [],
  distanceM: 0,
  turns: [],
};

function newRouteId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export const useRun = create<RunState>((set) => ({
  ...empty,
  index: 0,
  changesetId: undefined,
  routeId: "",
  hasPlan: false,
  setPlan: (p) =>
    set({ ...p, index: 0, changesetId: undefined, routeId: newRouteId(), hasPlan: true }),
  hydrate: (p) =>
    set({
      ...p,
      // Back-compat: runs persisted before these fields existed.
      tagValue: p.tagValue ?? empty.tagValue,
      pool: p.pool ?? [],
      added: p.added ?? [],
      index: p.index ?? 0,
      changesetId: p.changesetId,
      routeId: p.routeId ?? newRouteId(),
      hasPlan: true,
    }),
  setStatus: (id, status) =>
    set((s) => ({
      stops: s.stops.map((st) => (st.id === id ? { ...st, status } : st)),
    })),
  setIndex: (i) => set({ index: i }),
  setChangeset: (id) => set({ changesetId: id }),
  addNode: (f) => set((s) => ({ added: [...s.added, f] })),
  // Undo of an on-the-fly create: the node is gone from OSM, drop it locally too.
  removeNode: (id) => set((s) => ({ added: s.added.filter((f) => f.id !== id) })),
  reset: () => set({ ...empty, index: 0, changesetId: undefined, routeId: "", hasPlan: false }),
}));
