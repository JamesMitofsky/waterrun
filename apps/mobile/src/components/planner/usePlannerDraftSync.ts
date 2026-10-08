import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePlanner, type Draft } from "@rosm/core/stores/planner";
import { api } from "../../ports/api";

// Contract: the in-progress planner route persists to /api/draft on every
// change so a force-quit can offer to resume it. On mobile /api/draft is
// backed by the device kv store (see ports/api.ts). Skipped until the initial
// load runs, while a resume offer is pending, and before any route exists —
// identical gating to the web hook.
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

  useEffect(() => {
    if (!slice.draftReady || slice.resumable || slice.stops.length === 0) return;
    const draft: Draft = {
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
    api
      .apiFetch("/api/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      .catch(() => {});
  }, [slice]);
}
