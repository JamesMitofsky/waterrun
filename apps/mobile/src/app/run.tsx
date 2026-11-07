import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PointSheetHost } from "../components/ui/PointSheetHost";
import { ArrowBendUpRightIcon } from "phosphor-react-native/src/icons/ArrowBendUpRight";
import { CheckCircleIcon } from "phosphor-react-native/src/icons/CheckCircle";
import { PlusIcon } from "phosphor-react-native/src/icons/Plus";
import { SkipBackIcon } from "phosphor-react-native/src/icons/SkipBack";
import { SkipForwardIcon } from "phosphor-react-native/src/icons/SkipForward";
import { XCircleIcon } from "phosphor-react-native/src/icons/XCircle";
import { DogIcon } from "../components/icons/DogIcon";
import { checkedAgoLabel } from "@water-run/core/checkDate";
import { STATUS_COLOR } from "@water-run/core/editStatus";
import { framePadding } from "@water-run/core/mapFrame";
import type { StopStatus } from "@water-run/core/stores/run";
import { useOutbox, type OutboxItem } from "@water-run/core/stores/outbox";
import { mapButtonsBottom, WaterRunMap, type MapButton } from "../map/WaterRunMap";
import { useRunSession, type RunSession } from "../run/useRunSession";
import { endRun } from "../run/runLifecycle";
import { PointSheet, pointEditOf } from "../components/PointSheet";
import { Button } from "../components/ui/Button";
import { PopIn } from "../components/ui/PopIn";
import { confirmDestructive } from "../components/ui/confirm";
import { useSignedIn } from "../auth/useSignedIn";
import { promptSignIn, SignInButton } from "../auth/SignInButton";

// Human-facing status shown in the end-of-run recap.
const STATUS_LABEL: Record<StopStatus, string> = {
  pending: "Not surveyed",
  confirm: "Working",
  broken: "Partially working",
  out_of_order: "Out of order",
  removed: "Removed",
  skipped: "Skipped",
};

// The compass points spelled out for VoiceOver, which would read "NE" as
// letters.
const COMPASS_WORDS: Record<string, string> = {
  N: "north",
  NE: "northeast",
  E: "east",
  SE: "southeast",
  S: "south",
  SW: "southwest",
  W: "west",
  NW: "northwest",
};

// A point's latest queued edit: a later survey of it supersedes the earlier.
function latestEdit(items: OutboxItem[], id: number | string): OutboxItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (String(items[i].nodeId) === String(id)) return items[i];
  }
  return undefined;
}

export default function RunScreen() {
  const [selectedId, setSelectedId] = useState<number | string | null>(null);
  const [addLocation, setAddLocation] = useState<{ lat: number; lon: number } | null>(null);
  const live = useRunSession({
    // Arriving puts the survey in front of the runner, unless they already
    // have a sheet open.
    onArrive: (stop) => {
      if (selectedId == null && addLocation == null) setSelectedId(stop.id);
    },
  });
  // Finish ends the run at once, resetting the stores this screen reads, but
  // the router only replaces the screen on its next render. Until then, and
  // while the summary slides over it, the screen keeps showing the run as it
  // was instead of an empty map and "Locating you…".
  const [ended, setEnded] = useState<RunSession | null>(null);
  const s = ended ?? live;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const signedIn = useSignedIn();

  // The spot whose add sheet is open, kept in step with it as it opens and
  // closes. An add settles up to its 30 s deadline later, and by then the sheet
  // may have been swiped away or opened again at another spot.
  const openAdd = useRef<{ lat: number; lon: number } | null>(null);
  const showAdd = (at: { lat: number; lon: number } | null) => {
    openAdd.current = at;
    setAddLocation(at);
  };
  // Adding a fountain creates it in OSM straight away (it can't wait in the
  // outbox the way an edit can), so that is the moment to ask for sign-in.
  const startAdd = (at: { lat: number; lon: number }) => {
    if (!signedIn) {
      promptSignIn({
        title: "Sign in to add fountains",
        message:
          "A new fountain goes straight onto OpenStreetMap, the free public map Water Run saves to, so adding one needs an OpenStreetMap account.",
      });
      return;
    }
    showAdd(at);
  };
  const [now, setNow] = useState(() => new Date());

  // The map keeps the runner and their next stop in the part of it the run
  // panel doesn't cover, so both sizes are measured as they change. At the
  // top, the status bar and the map buttons below it count as covered.
  const [mapSize, setMapSize] = useState({ width: 0, height: 0 });
  const [panelHeight, setPanelHeight] = useState(0);
  const onScreenLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setMapSize({ width, height });
  };
  const onPanelLayout = (e: LayoutChangeEvent) => setPanelHeight(e.nativeEvent.layout.height);
  // Both buttons (follow, add here) show once there is a fix.
  const buttonCount = s.located ? 2 : 0;
  const mapPadding = useMemo(
    () =>
      framePadding({
        width: mapSize.width,
        height: mapSize.height,
        coverTop: insets.top + mapButtonsBottom(buttonCount),
        coverBottom: panelHeight,
      }),
    [mapSize, insets.top, panelHeight, buttonCount],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // Points the surveyor actually touched this run: stops with a recorded status
  // plus any nodes created on the fly. Drives the end-of-run recap list.
  const surveyed = useMemo(
    () => s.stops.filter((st) => st.status !== "pending" && st.status !== "skipped"),
    [s.stops],
  );

  // Set synchronously, so Finish runs once. The button stays until the replace
  // lands, and a second tap would freeze the screen on the reset run and queue
  // a replace to the planner behind the one to the summary.
  const finished = useRef(false);

  // Finishing never waits on the network: the run ends on the device and the
  // summary opens at once; the changeset closes in the background.
  const handleFinish = () => {
    if (finished.current) return;
    finished.current = true;
    setEnded(live);
    const routeId = endRun();
    if (routeId) router.replace({ pathname: "/run-detail", params: { id: routeId, fresh: "1" } });
    else router.replace("/plan");
  };

  const confirmEndEarly = () =>
    confirmDestructive({
      title: "End this route early?",
      message: "The stops you haven't reached are left for next time.",
      confirm: "End Route",
      onConfirm: () => s.endEarly(),
    });

  const selectedPoint = useMemo(() => {
    if (selectedId == null) return null;
    return (
      s.stops.find((st) => st.id === selectedId) ??
      s.added.find((a) => a.id === selectedId) ??
      s.pool.find((p) => p.id === selectedId) ??
      null
    );
  }, [selectedId, s.stops, s.added, s.pool]);

  // The tapped point's latest queued edit, followed while the sheet is open so
  // its sync state (and a Retry) stays current. Only a change to that edit
  // re-renders the screen.
  const selectedItem = useOutbox((o) =>
    selectedId == null ? undefined : latestEdit(o.items, selectedId),
  );
  const selectedEdit = useMemo(
    () => (selectedItem ? pointEditOf(selectedItem) : undefined),
    [selectedItem],
  );

  const mapMarkers = useMemo(() => {
    if (!addLocation) return s.markers;
    return [
      ...s.markers,
      {
        id: "pending-add",
        lat: addLocation.lat,
        lon: addLocation.lon,
        color: "#16a34a",
        label: "+",
      },
    ];
  }, [s.markers, addLocation]);

  // The gesture's alternative (HIG: Accessibility): add a fountain where the
  // runner stands, which is where an unmapped one usually is.
  const mapButtons: MapButton[] | undefined = s.pos
    ? [
        {
          icon: <PlusIcon size={22} color="#1d1d1f" weight="bold" />,
          label: "Add a fountain here",
          onPress: () => s.pos && startAdd(s.pos),
        },
      ]
    : undefined;

  // Reached with no run to show (a stale link, or the run already ended):
  // back to where runs start.
  if (s.nothingToResume) return <Redirect href="/plan" />;

  if (s.hydrating) {
    return (
      <View className="bg-base flex-1 items-center justify-center gap-3">
        <ActivityIndicator color="#eef2f6" />
        <Text className="text-light font-medium">Loading your run…</Text>
      </View>
    );
  }

  const stopName = s.target ? (s.target.tags?.name ?? `Stop ${s.index + 1}`) : "";

  return (
    <View className="bg-base flex-1" onLayout={onScreenLayout}>
      <WaterRunMap
        center={s.center}
        markers={mapMarkers}
        line={s.line}
        showUserLocation={s.located}
        fitPoints={s.fitPoints}
        framePadding={mapPadding}
        showLocationButton
        buttons={mapButtons}
        onMarkerPress={setSelectedId}
        // Touch and hold, not a tap: a stray tap mid-run must not open a form.
        onMapLongPress={(lat, lon) => startAdd({ lat, lon })}
      />
      {/* A full-screen stack screen, so the root provider's inset is this
          screen's: the panel clears the home indicator and Android's 3-button
          bar (48dp; edge to edge is always on), and keeps at least its own
          32pt below the last button. */}
      <View
        className="bg-base border-light/10 absolute right-0 bottom-0 left-0 gap-1 border-t px-5 pt-5"
        style={{ paddingBottom: Math.max(32, insets.bottom + 8) }}
        onLayout={onPanelLayout}
      >
        {s.done ? (
          <>
            <Text accessibilityRole="header" className="text-light text-2xl font-bold">
              Route complete
            </Text>
            <Text className="text-light-muted text-callout mb-3">
              {surveyed.length + s.added.length} of {s.stops.length} points surveyed
            </Text>
            {surveyed.length + s.added.length > 0 ? (
              <ScrollView className="mb-4 max-h-44">
                <View className="gap-2">
                  {surveyed.map((st) => (
                    <View key={st.id} className="flex-row items-center gap-2">
                      <View
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: STATUS_COLOR[st.status] }}
                      />
                      {/* Few fountains are named; the rest go by their stop
                          number, the one their map marker shows. */}
                      <Text className="text-light text-callout flex-1" numberOfLines={1}>
                        {st.tags?.name ?? `Stop ${s.stops.indexOf(st) + 1}`}
                      </Text>
                      <Text className="text-light-muted text-sm">{STATUS_LABEL[st.status]}</Text>
                    </View>
                  ))}
                  {s.added.map((f) => (
                    <View key={f.id} className="flex-row items-center gap-2">
                      <View
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: "#16a34a" }}
                      />
                      <Text className="text-light text-callout flex-1" numberOfLines={1}>
                        {f.tags?.name ?? "New fountain"}
                      </Text>
                      <Text className="text-light-muted text-sm">Added</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : (
              <Text className="text-light-muted text-callout mb-4">
                No points surveyed. Finish to save your route.
              </Text>
            )}
            <Button title="Finish Run" variant="action" size="lg" onPress={handleFinish} />
          </>
        ) : s.target ? (
          <>
            {/* What a runner needs at a glance, largest first (HIG: Workouts):
                how far, which way, then the turn that gets them there. */}
            {s.cue ? (
              <View
                accessible
                accessibilityLabel={`${stopName}, ${s.cue.distance} ${
                  COMPASS_WORDS[s.cue.direction] ?? s.cue.direction
                }`}
                className="flex-row items-baseline gap-3"
              >
                <Text
                  className="text-light text-5xl font-bold"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {s.cue.distance}
                </Text>
                <Text className="text-light-muted text-2xl font-semibold">{s.cue.direction}</Text>
              </View>
            ) : s.locationDenied ? null : (
              <View className="flex-row items-center gap-3 py-2">
                <ActivityIndicator color="#eef2f6" />
                <Text className="text-light-muted text-lg">Locating you…</Text>
              </View>
            )}
            <Text
              accessibilityRole="header"
              className="text-light text-xl font-semibold"
              numberOfLines={2}
            >
              {stopName}
            </Text>
            {s.cue?.turn ? (
              <View className="flex-row items-center gap-2">
                <ArrowBendUpRightIcon size={20} color="#eef2f6" weight="bold" />
                <Text className="text-light flex-1 text-lg font-medium">{s.cue.turn}</Text>
              </View>
            ) : null}
            {/* Core's label, as the point sheet's status line uses: both read
                the same survey keys, so the panel and the sheet agree. */}
            <Text className="text-light-muted text-callout">
              {checkedAgoLabel(s.target.tags ?? {}, now.getTime(), "long")}
            </Text>

            {s.target.tags?.drinking_water === "no" ? (
              <View className="flex-row items-center gap-1.5">
                <DogIcon size={16} color="#a78bfa" />
                <Text className="text-callout font-medium text-violet-400">
                  Dog water — not for humans
                </Text>
              </View>
            ) : null}

            {!signedIn ? (
              <View className="mt-1 flex-row items-center gap-3">
                <Text className="text-light-muted flex-1 text-sm">
                  Updates are kept on this phone until you sign in.
                </Text>
                <SignInButton style="link" tone="light" />
              </View>
            ) : null}

            <View className="gap-4 pt-4 pb-3">
              <Button
                title="I'm Here"
                variant="action"
                size="lg"
                onPress={() => {
                  s.setManualArrived(true);
                  if (s.target) setSelectedId(s.target.id);
                }}
              />
              <View className="flex-row gap-3">
                <Pressable
                  onPress={confirmEndEarly}
                  accessibilityRole="button"
                  accessibilityLabel="End route early"
                  className="flex-1 flex-row items-center justify-center gap-2 rounded-full border border-red-400/40 bg-red-950/20 px-4 py-4 active:opacity-70"
                >
                  <XCircleIcon size={24} color="#f87171" />
                  <Text className="text-callout font-bold text-red-400">End</Text>
                </Pressable>
                {s.index > 0 ? (
                  <Pressable
                    onPress={() => s.goBack()}
                    accessibilityRole="button"
                    accessibilityLabel="Back to previous stop"
                    className="border-light/25 flex-1 flex-row items-center justify-center gap-2 rounded-full border px-4 py-4 active:opacity-70"
                  >
                    <SkipBackIcon size={24} color="#f7f2e8" />
                    <Text className="text-light text-callout font-semibold">Back</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => s.skip()}
                  accessibilityRole="button"
                  accessibilityLabel="Skip this stop"
                  className="border-light/25 flex-1 flex-row items-center justify-center gap-2 rounded-full border px-4 py-4 active:opacity-70"
                >
                  <SkipForwardIcon size={24} color="#f7f2e8" />
                  <Text className="text-light text-callout font-semibold">Skip</Text>
                </Pressable>
              </View>
            </View>
          </>
        ) : (
          <View className="flex-row items-center gap-3 py-2">
            <ActivityIndicator color="#eef2f6" />
            <Text className="text-light-muted text-lg">Locating you…</Text>
          </View>
        )}

        {s.lastSaved ? (
          // Pops on every save: the sheet closes as the edit is recorded, so
          // this line is the only sign it took.
          <PopIn trigger={s.lastSaved}>
            <View className="flex-row items-center gap-2">
              <CheckCircleIcon size={18} color="#4ade80" weight="fill" />
              <Text className="text-callout flex-1 text-green-300">
                Saved · {s.lastSaved.label}
              </Text>
              {s.undoOpen ? (
                <Pressable
                  onPress={s.undoLast}
                  accessibilityRole="button"
                  accessibilityLabel={`Undo ${s.lastSaved.label}`}
                  hitSlop={12}
                >
                  <Text className="text-info text-callout font-bold">Undo</Text>
                </Pressable>
              ) : null}
            </View>
          </PopIn>
        ) : null}
        {s.err ? (
          <View className="gap-2">
            <Text className="text-callout text-red-400">{s.err}</Text>
            {s.locationDenied ? (
              <Button
                title="Open Settings"
                variant="ghost-dark"
                onPress={() => void Linking.openSettings()}
              />
            ) : null}
          </View>
        ) : null}
      </View>

      <PointSheetHost isPresented={selectedId != null} onDismiss={() => setSelectedId(null)}>
        {selectedPoint ? (
          <PointSheet
            fountain={selectedPoint}
            edit={selectedEdit}
            // A stop set back to pending (Back) is there to be answered again,
            // so the questions show rather than the answer on record.
            reask={"status" in selectedPoint && selectedPoint.status === "pending"}
            onAction={(action, extras) => {
              s.recordFor(selectedPoint, action, extras);
              setSelectedId(null);
            }}
          />
        ) : null}
      </PointSheetHost>

      <PointSheetHost isPresented={addLocation != null} onDismiss={() => showAdd(null)}>
        {addLocation ? (
          <PointSheet
            fountain={{
              id: -1,
              lat: addLocation.lat,
              lon: addLocation.lon,
              tags: { amenity: "drinking_water" },
            }}
            // The sheet, and what was typed into it, stays until the point
            // exists: a failed add shows its reason there for another try.
            // Once the sheet has been swiped away (it can be, mid-save) the
            // reason goes to the run panel instead, and a late success leaves
            // alone a sheet since opened at another spot.
            onAction={async (_action, extras) => {
              try {
                await s.addAt(addLocation, extras);
              } catch (e) {
                if (openAdd.current !== addLocation) {
                  s.reportError(`Point not added. ${e instanceof Error ? e.message : String(e)}`);
                }
                throw e;
              }
              if (openAdd.current === addLocation) showAdd(null);
            }}
          />
        ) : null}
      </PointSheetHost>
    </View>
  );
}
