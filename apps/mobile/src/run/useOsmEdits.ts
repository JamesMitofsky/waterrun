import { useCallback, useMemo } from "react";
import type { EditExtras } from "@rosm/core/schemas";
import { useOutbox } from "@rosm/core/stores/outbox";
import { celebratePoint } from "../ports/confetti";
import { hapticSuccess } from "../ports/haptics";
import { pointEditOf, type PointEdit, type SurveyAction } from "../components/PointSheet";

export function useOsmEdits({ tagKey }: { tagKey: string }) {
  const outboxItems = useOutbox((s) => s.items);

  const edits = useMemo(() => {
    const m: Record<number, PointEdit> = {};
    for (const it of outboxItems) m[it.nodeId] = pointEditOf(it);
    return m;
  }, [outboxItems]);

  const updatePoint = useCallback(
    (nodeId: number, action: SurveyAction, name?: string, extras?: EditExtras) => {
      useOutbox.getState().enqueue({ nodeId, action, tagKey, name, extras });
      celebratePoint();
      hapticSuccess();
      useOutbox.getState().flush();
    },
    [tagKey],
  );

  return { edits, updatePoint };
}

export type OsmEdits = ReturnType<typeof useOsmEdits>;
