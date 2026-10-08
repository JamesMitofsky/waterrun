import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { PointSheetHost } from "../../components/ui/PointSheetHost";
import { usePlanner, inRouteIdsOf } from "@rosm/core/stores/planner";
import { fmtDist } from "@rosm/core/geo";
import type { Fountain } from "@rosm/core/schemas";
import { Button } from "../../components/ui/Button";
import { RosmMap, type RosmMarker } from "../../map/RosmMap";
import { getLastKnownPosition } from "../../ports/geolocation";
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

// The Survey tab: a single persistent map for the whole planner lifetime, with
// the config wizard / route builder / run-in-progress card swapping in a bottom
// panel over it (the web planner keeps one MapView the same way). The run phase
// itself lives on the standalone /run screen.
export default function Plan() {
  const router = useRouter();

  // Narrow slices only — the map re-diffs its native sources on prop changes,
  // so busy/err churn in the panels must not reach it.
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
  const busy = usePlanner((s) => s.busy);

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

  // Auto-locate on mount: skip config phase and begin querying a 4 mile radius immediately.
  useEffect(() => {
    const s = usePlanner.getState();
    s.setRadiusMi(4);
    if (s.phase === "config") {
      s.setPhase("map");
    }

    (async () => {
      if (!usePlanner.getState().center) {
        const quick = await getLastKnownPosition();
        if (quick && !usePlanner.getState().center) {
          usePlanner.getState().recenter({ lat: quick.lat, lon: quick.lon });
        }
        usePlanner.getState().geolocate();
      }
    })();
  }, []);

  // Whenever center becomes available in map phase with no fountains loaded yet, query points.
  useEffect(() => {
    if (
      center &&
      phase === "map" &&
      fountains.length === 0 &&
      busy === null &&
      !usePlanner.getState().err
    ) {
      usePlanner.getState().findPoints();
    }
  }, [center, phase, fountains.length, busy]);

  // A saved route from a prior session — offer to resume it, natively.
  useEffect(() => {
    if (!resumable) return;
    Alert.alert(
      "Resume your route?",
      `${resumable.stops.length} stops · ${fmtDist(resumable.distanceM)}`,
      [
        { text: "Start fresh", onPress: () => usePlanner.getState().dismissDraft() },
        { text: "Resume", isPreferred: true, onPress: () => usePlanner.getState().resumeDraft() },
      ],
    );
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
        showUserLocation={center !== null}
        initialOnly
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
