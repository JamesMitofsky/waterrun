import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { usePlanner, type Draft } from "@rosm/core/stores/planner";
import { draftSaveAction } from "@rosm/core/draftSave";
import { api } from "../../ports/api";

// How long the route has to sit still before it is saved. One tap changes it
// twice (the picks, then the re-planned route a moment later), and each save
// serializes the whole draft, every point found included, then writes it
// synchronously on the JS thread.
const SAVE_DELAY_MS = 500;

// Contract: the in-progress planner route persists to /api/draft on every
// change so a force-quit can offer to resume it. On mobile /api/draft is
// backed by the device kv store (see ports/api.ts). Skipped until the initial
// load runs, while a resume offer is pending, and before any route exists —
// identical gating to the web hook. A stale route isn't saved either, since a
// resume would take it as current (see draftSaveAction). Saves are coalesced
// (SAVE_DELAY_MS), and one still waiting goes out at once when the app leaves
// the foreground, the last moment before a kill.
export function usePlannerDraftSync() {
  // Mount: look for a saved route from a prior session.
  useEffect(() => {
    usePlanner.getState().loadDraft();
  }, []);

  // The draft slice; useShallow keeps the object identity stable until one of
  // these values actually changes (arrays/objects by reference).
  const slice = usePlanner(
    useShallow((s) => ({
      draftReady: s.draftReady,
      resumable: s.resumable,
      routeStale: s.routeStale,
      center: s.center,
      tag: s.tag,
      radiusMi: s.radiusMi,
      recencyMode: s.recencyMode,
      recencyMonths: s.recencyMonths,
      targetMi: s.targetMi,
      loop: s.loop,
      fountains: s.fountains,
      pinnedIds: s.pinnedIds,
      excludedIds: s.excludedIds,
      vias: s.vias,
      stops: s.stops,
      // The routed order (vias included) and the direction the user chose, so
      // a resumed route reverses with its vias instead of re-planning.
      order: s.order,
      reversed: s.reversed,
      line: s.line,
      distanceM: s.distanceM,
      turns: s.turns,
      autoCount: s.autoCount,
    })),
  );

  const pending = useRef<Draft | null>(null);

  useEffect(() => {
    const action = draftSaveAction(slice);
    if (action === "drop") {
      // Nothing to save now, and a draft still waiting is no longer the route.
      pending.current = null;
      return;
    }
    // A stale route's stops and line predate its picks, so it isn't saved; a
    // draft still waiting is the last route that planned, and still goes out.
    if (action === "save") {
      pending.current = {
        center: slice.center!,
        tag: slice.tag,
        radiusMi: slice.radiusMi,
        recencyMode: slice.recencyMode,
        recencyMonths: slice.recencyMonths,
        targetMi: slice.targetMi,
        loop: slice.loop,
        fountains: slice.fountains,
        pinnedIds: slice.pinnedIds,
        excludedIds: slice.excludedIds,
        vias: slice.vias,
        stops: slice.stops,
        order: slice.order,
        reversed: slice.reversed,
        line: slice.line,
        distanceM: slice.distanceM,
        turns: slice.turns,
        autoCount: slice.autoCount,
      };
    }
    const t = setTimeout(() => savePending(pending), SAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [slice]);

  // Leaving the foreground, or the planner going away, saves what's waiting.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") savePending(pending);
    });
    return () => {
      sub.remove();
      savePending(pending);
    };
  }, []);
}

function savePending(pending: { current: Draft | null }) {
  const draft = pending.current;
  pending.current = null;
  // Starting a run deletes the draft; a save that was still waiting must not
  // bring it back, or the next launch would offer to resume a route already run.
  if (!draft || usePlanner.getState().phase === "run") return;
  api
    .apiFetch("/api/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    })
    .catch(() => {});
}
