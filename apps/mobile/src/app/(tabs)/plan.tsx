import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { useIsFocused, useRouter } from "expo-router";
import { PointSheetHost } from "../../components/ui/PointSheetHost";
import { usePlanner, inRouteIdsOf, shouldAutoFindPoints } from "@rosm/core/stores/planner";
import { fmtDist } from "@rosm/core/geo";
import type { Fountain } from "@rosm/core/schemas";
import { Button } from "../../components/ui/Button";
import { RosmMap, type RosmMarker } from "../../map/RosmMap";
import { recentFix } from "../../ports/locateFast";
import { RouteBuilderPanel } from "../../components/planner/RouteBuilderPanel";
import { PhaseNav } from "../../components/planner/PhaseNav";
import { usePlannerMarkers } from "../../components/planner/usePlannerMarkers";
import { usePlannerDraftSync } from "../../components/planner/usePlannerDraftSync";
import { useOsmEdits } from "../../run/useOsmEdits";
import { endRun } from "../../run/runLifecycle";
import { PointSheet } from "../../components/PointSheet";
import { hapticSelect } from "../../ports/haptics";

function markLabel(f: Fountain) {
  return f.tags.name ?? "Unnamed fountain";
}

// True from the first time this tab is shown. Native tabs render every tab at
// launch (expo-router has no lazy option), and this one would otherwise start
// a second map, a GPS fix, a 4-mile search and the resume offer behind the
// landing tab.
function useOpenedOnce(): boolean {
  const focused = useIsFocused();
  const [opened, setOpened] = useState(focused);
  if (focused && !opened) setOpened(true);
  return opened;
}

// The Survey tab: a single persistent map for the whole planner lifetime, with
// the config wizard / route builder / run-in-progress card swapping in a bottom
// panel over it (the web planner keeps one MapView the same way). The run phase
// itself lives on the standalone /run screen.
export default function Plan() {
  return useOpenedOnce() ? <PlanContent /> : <View className="bg-surface flex-1" />;
}

function PlanContent() {
  const router = useRouter();
  // The map only draws the device's location while this tab is on screen.
  const isFocused = useIsFocused();

  // Narrow slices only, so unrelated planner churn doesn't re-render the map.
  const phase = usePlanner((s) => s.phase);
  const center = usePlanner((s) => s.center);
  const recenterKey = usePlanner((s) => s.recenterKey);
  const animateRecenter = usePlanner((s) => s.animateRecenter);
  const line = usePlanner((s) => s.line);
  const tag = usePlanner((s) => s.tag);
  const fountains = usePlanner((s) => s.fountains);
  const stops = usePlanner((s) => s.stops);
  const pinnedIds = usePlanner((s) => s.pinnedIds);
  const excludedIds = usePlanner((s) => s.excludedIds);
  const distanceM = usePlanner((s) => s.distanceM);
  const resumable = usePlanner((s) => s.resumable);
  const draftReady = usePlanner((s) => s.draftReady);
  const busy = usePlanner((s) => s.busy);
  const err = usePlanner((s) => s.err);

  usePlannerDraftSync();
  const { edits, updatePoint } = useOsmEdits({ tagKey: tag.key });
  const markers = usePlannerMarkers({ edits });

  // Track the tapped point by id — the sheet opens instantly (spinner until the
  // fountain resolves), same pattern as the quick-update tab.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = useMemo(
    () => (selectedId == null ? null : (fountains.find((f) => f.id === selectedId) ?? null)),
    [fountains, selectedId],
  );
  const inRouteIds = useMemo(
    () => inRouteIdsOf({ stops, pinnedIds, excludedIds }),
    [stops, pinnedIds, excludedIds],
  );

  // Auto-locate on mount: skip config phase and begin querying a 4 mile radius
  // immediately. The phone's recent fix (when it has one fresh and close
  // enough) places the start at once; the GPS fix then refines it.
  useEffect(() => {
    const s = usePlanner.getState();
    s.setRadiusMi(4);
    if (s.phase === "config") {
      s.setPhase("map");
    }

    (async () => {
      if (!usePlanner.getState().center) {
        const quick = await recentFix();
        if (quick && !usePlanner.getState().center) {
          usePlanner.getState().recenter(quick);
        }
        usePlanner.getState().geolocate();
      }
    })();
  }, []);

  // Search for points once there is a start and nothing loaded, but not while
  // a saved route is on offer: the search would wipe the stops the user may be
  // about to restore. Turning the offer down lets it run.
  useEffect(() => {
    const fountainsCount = fountains.length;
    if (shouldAutoFindPoints({ center, phase, fountainsCount, busy, err, draftReady, resumable })) {
      usePlanner.getState().findPoints();
    }
  }, [center, phase, fountains.length, busy, err, draftReady, resumable]);

  // A saved route from a prior session — offer to resume it, natively. The
  // choice restores the draft the offer showed, whatever happened meanwhile.
  useEffect(() => {
    if (!resumable) return;
    const draft = resumable;
    Alert.alert("Resume your route?", `${draft.stops.length} stops · ${fmtDist(draft.distanceM)}`, [
      { text: "Start fresh", onPress: () => usePlanner.getState().dismissDraft() },
      {
        text: "Resume",
        isPreferred: true,
        onPress: () => usePlanner.getState().resumeDraft(draft),
      },
    ]);
  }, [resumable]);

  // Config step 0: tap sets the start. Map phase: tap drops a via waypoint.
  const onMapPress = useCallback((lat: number, lon: number) => {
    usePlanner.getState().mapClick(lat, lon);
  }, []);

  // Numeric ids are fountains (toggling in route during build phase); "via-N" removes that waypoint;
  // the start flag and island highlight ignore taps.
  const onMarkerPress = useCallback(
    (id: RosmMarker["id"]) => {
      if (typeof id === "number") {
        if (phase === "map") {
          hapticSelect();
          usePlanner.getState().toggleStop(id);
          return;
        }
        setSelectedId(id);
        return;
      }
      if (id.startsWith("via-")) {
        hapticSelect();
        usePlanner.getState().removeVia(Number(id.slice(4)));
      }
    },
    [phase],
  );

  const startRun = useCallback(async () => {
    // Only leave the planner for a run that really started; otherwise the
    // planner's error (e.g. the route is still updating) is shown here.
    if (await usePlanner.getState().startRun()) router.replace("/run");
  }, [router]);

  // The same teardown as Finish on the run screen: unsent edits stay queued.
  const confirmEndRun = useCallback(() => {
    Alert.alert("End this run?", "Progress is archived; queued edits keep syncing.", [
      { text: "Cancel", style: "cancel" },
      { text: "End run", style: "destructive", onPress: () => void endRun() },
    ]);
  }, []);

  const mapCenter: [number, number] = center ? [center.lat, center.lon] : [20, 0];

  return (
    <View className="bg-surface flex-1">
      <RosmMap
        center={mapCenter}
        zoom={center ? 15 : 1.5}
        markers={markers}
        line={line}
        // A start exists once location was granted and fixed, or the user
        // tapped one in; with location denied the puck just has nothing to show.
        showUserLocation={isFocused && center !== null}
        recenterKey={recenterKey}
        animateRecenter={animateRecenter}
        onMapPress={onMapPress}
        onMarkerPress={onMarkerPress}
      />

      {/* Floating spinner overlay in the middle of the map while querying points */}
      {busy === "find" ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 z-10 items-center justify-center bg-black/25 pb-36"
        >
          <View
            className="bg-base flex-row items-center gap-3 rounded-full px-6 py-3 shadow-xl"
            accessibilityRole="progressbar"
            accessibilityLabel="Finding points nearby"
          >
            <ActivityIndicator size="small" color="#f7f2e8" />
            <Text className="text-surface text-sm font-semibold">Finding points…</Text>
          </View>
        </View>
      ) : null}

      {/* Planner controls pinned to the bottom of the screen, full-width,
          matching the active-run panel in run.tsx. */}
      <View className="bg-surface border-base/10 absolute right-0 bottom-0 left-0 border-t px-5 pt-5 pb-28">
        {phase === "run" ? (
          <View className="gap-3">
            <Text className="text-base font-bold">
              Run in progress — {stops.length} stops · {fmtDist(distanceM)}
            </Text>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button title="Open run" onPress={() => router.push("/run")} />
              </View>
              <Button title="End run" variant="danger" onPress={confirmEndRun} />
            </View>
            {/* Last view — step back to the builder; no forward. */}
            <PhaseNav
              back={{
                label: "Pick fountains",
                onPress: () => usePlanner.getState().setPhase("map"),
              }}
            />
          </View>
        ) : (
          <RouteBuilderPanel onStartRun={startRun} />
        )}
      </View>

      {/* Native OS bottom sheet for the tapped point (shared with the other
          survey screens — see PointSheetHost for sizing and the keyboard). */}
      <PointSheetHost isPresented={selectedId != null} onDismiss={() => setSelectedId(null)}>
        {selected ? (
          <PointSheet
            fountain={selected}
            edit={edits[selected.id]}
            inRoute={inRouteIds.has(selected.id)}
            onToggleRoute={() => {
              hapticSelect();
              usePlanner.getState().toggleStop(selected.id);
              setSelectedId(null);
            }}
            onAction={(action, extras) =>
              updatePoint(selected.id, action, markLabel(selected), extras)
            }
          />
        ) : (
          <View className="items-center justify-center py-12">
            <ActivityIndicator />
          </View>
        )}
      </PointSheetHost>
    </View>
  );
}
