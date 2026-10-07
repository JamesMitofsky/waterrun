import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ArrowCounterClockwiseIcon } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { usePlanner, removedOf } from "@rosm/core/stores/planner";
import type { Fountain } from "@rosm/core/schemas";
import { fmtDist } from "@rosm/core/geo";
import { Button } from "../ui/Button";
import { PhaseNav } from "./PhaseNav";

function markLabel(f: Fountain) {
  return f.tags.name ?? "Unnamed fountain";
}

// Map phase bottom card: point-picking, route summary, reverse direction, and
// the start-run handoff.
export function RouteBuilderPanel({ onStartRun }: { onStartRun: () => void }) {
  const p = usePlanner();

  const removed = useMemo(
    () => removedOf(p),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.fountains, p.excludedIds],
  );

  const hasSelectedFountains = p.stops.length > 0 || p.pinnedIds.length > 0;

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Text className="text-base text-lg font-bold">
          Tap fountains to add/remove them from your route
        </Text>
      </View>

      {removed.length > 0 ? (
        <View className="gap-1">
          <Text className="text-muted text-xs font-semibold">
            Removed from route ({removed.length})
          </Text>
          <ScrollView className="max-h-24">
            {removed.map((f) => (
              <View
                key={f.id}
                className="bg-surface-deep mb-1 flex-row items-center justify-between rounded-lg px-2 py-1.5"
              >
                <Text className="text-muted flex-1 text-xs line-through" numberOfLines={1}>
                  {markLabel(f)}
                </Text>
                <Pressable
                  onPress={() => p.restoreStop(f.id)}
                  accessibilityRole="button"
                  accessibilityLabel="add point back to route"
                >
                  <Text className="text-link text-xs font-semibold">Add back</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {p.stops.length > 0 ? (
        <View className="border-link/30 bg-info/10 gap-2 rounded-2xl border p-3">
          <View className="flex-row items-baseline justify-between">
            <Text className="text-base font-semibold">{p.stops.length} stops</Text>
            <Text className="text-link font-semibold">{fmtDist(p.distanceM)}</Text>
          </View>
          {p.autoCount > 0 ? (
            <Text className="text-muted text-xs">
              Fountains in purple were added dynamically along your route and will update as your
              selections change.
            </Text>
          ) : null}
          {p.stops.length > 1 ? (
            <Button
              title={p.busy === "reverse" ? "Reversing…" : "Reverse Direction"}
              variant="secondary"
              icon={<ArrowCounterClockwiseIcon size={18} color="#0c0d0a" weight="bold" />}
              disabled={p.busy !== null}
              onPress={() => p.reverseRoute()}
            />
          ) : null}
        </View>
      ) : null}

      {p.err ? (
        <View className="gap-2">
          <Text className="text-sm text-red-500">{p.err}</Text>
          {p.islandPt ? (
            <Text className="text-muted text-xs">
              It’s marked ! in red on the map. Remove that point (or move your nearest waypoint),
              then the route re-plans on its own.
            </Text>
          ) : null}
          {p.errRetryable ? (
            <Button
              title="Retry"
              variant="secondary"
              loading={p.busy === "find"}
              onPress={() => p.findPoints()}
            />
          ) : null}
        </View>
      ) : null}

      {/* Forward starts the run once a route exists. */}
      <PhaseNav
        forward={{
          label: "Start run",
          onPress: onStartRun,
          disabled: !hasSelectedFountains || p.busy !== null,
        }}
      />
    </View>
  );
}
