import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ArrowCounterClockwiseIcon } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { usePlanner } from "@water-run/core/stores/planner";
import { fmtDist } from "@water-run/core/geo";
import { startRunBlocker } from "@water-run/core/startRunGate";
import { Button } from "../ui/Button";

// Map phase bottom card: route summary, reverse direction, and the start-run
// handoff, the panel's one prominent button (HIG: Buttons). Kept to a few lines
// so the map, where the fountains are picked, gets most of the screen. Picking
// happens there too: a tap adds or removes a fountain, and a removed one stays
// on the map, dimmed, to be tapped back in.
export function RouteBuilderPanel({ onStartRun }: { onStartRun: () => void }) {
  const p = usePlanner();

  const hasSelectedFountains = p.stops.length > 0 || p.pinnedIds.length > 0;
  const blocker = startRunBlocker({
    hasSelectedFountains,
    busy: p.busy,
    routeStale: p.routeStale,
    hasError: !!p.err,
  });

  // Retry re-runs whatever failed. A route that failed is re-planned from the
  // current picks; searching again would throw them away.
  const retry =
    p.errSource === "route"
      ? { loading: p.busy === "route", run: () => p.retryRoute() }
      : { loading: p.busy === "find", run: () => p.findPoints() };

  // With no start yet (location denied, or no fix so far), touching and
  // holding the map sets one; with one, it routes through that spot. Touch
  // and hold, so a stray tap or a pan never does either.
  const title = !p.center
    ? "Set your start"
    : p.stops.length > 0
      ? `${p.stops.length} ${p.stops.length === 1 ? "stop" : "stops"} · ${fmtDist(p.distanceM)}`
      : "Pick your fountains";
  const hint = !p.center
    ? "Touch and hold the map where your run starts."
    : `Tap a fountain to add or remove it. Hold the map to route through a spot.${
        p.autoCount > 0 ? " Purple ones were picked up along the way." : ""
      }`;

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-0.5">
          <Text accessibilityRole="header" className="text-base text-lg font-bold">
            {title}
          </Text>
          <Text className="text-muted text-sm">{hint}</Text>
        </View>
        {p.stops.length > 1 ? (
          <Pressable
            onPress={() => p.reverseRoute()}
            disabled={p.busy !== null}
            accessibilityRole="button"
            accessibilityLabel="Reverse direction"
            accessibilityHint="Runs the same route the other way round"
            accessibilityState={{ disabled: p.busy !== null, busy: p.busy === "reverse" }}
            className={`bg-surface-deep h-11 w-11 items-center justify-center rounded-full active:opacity-70 ${
              p.busy !== null ? "opacity-50" : ""
            }`}
          >
            {p.busy === "reverse" ? (
              <ActivityIndicator color="#0c0d0a" />
            ) : (
              <ArrowCounterClockwiseIcon size={20} color="#0c0d0a" weight="bold" />
            )}
          </Pressable>
        ) : null}
      </View>

      {/* The points came from data hours old (see dataAgeNotice). */}
      {p.pointsNotice ? <Text className="text-muted text-sm">{p.pointsNotice}</Text> : null}

      {p.err ? (
        <View className="gap-2">
          <Text className="text-callout text-red-700">{p.err}</Text>
          {p.islandPt ? (
            <Text className="text-muted text-sm">
              It’s marked ! in red on the map. Remove that point (or move your nearest waypoint),
              then the route re-plans on its own.
            </Text>
          ) : null}
          {p.errRetryable ? (
            <Button title="Retry" variant="secondary" loading={retry.loading} onPress={retry.run} />
          ) : null}
        </View>
      ) : null}

      {/* Starts the run once a route exists, and only from a route that
          matches the picks: while it is re-planning, or after that failed,
          the stops and line on hand are the previous route's. While it
          can't, the line under it says why. */}
      <View className="gap-1.5">
        <Button
          title="Start Run"
          variant="action"
          onPress={onStartRun}
          disabled={blocker !== null}
          accessibilityHint={blocker ?? undefined}
        />
        {blocker ? (
          <Text className="text-muted text-center text-sm" accessibilityElementsHidden>
            {blocker}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
