import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PointSheetHost } from "../components/ui/PointSheetHost";
import { CheckCircleIcon } from "phosphor-react-native/src/icons/CheckCircle";
import { SkipBackIcon } from "phosphor-react-native/src/icons/SkipBack";
import { SkipForwardIcon } from "phosphor-react-native/src/icons/SkipForward";
import { XCircleIcon } from "phosphor-react-native/src/icons/XCircle";
import { DogIcon } from "../components/icons/DogIcon";
import { fmtDist, maneuver } from "@rosm/core/geo";
import { STATUS_COLOR } from "@rosm/core/editStatus";
import type { StopStatus } from "@rosm/core/stores/run";
import { useOutbox, type OutboxItem } from "@rosm/core/stores/outbox";
import { RosmMap } from "../map/RosmMap";
import { useRunSession, type RunSession } from "../run/useRunSession";
import { endRun } from "../run/runLifecycle";
import { PointSheet, pointEditOf } from "../components/PointSheet";
import { Button } from "../components/ui/Button";

function checkedAgoLabel(tags?: Record<string, string>, now: Date = new Date()): string {
  const d = tags?.check_date ?? tags?.["check_date:drinking_water"];
  if (!d) return "Not surveyed yet";
  const diffMs = now.getTime() - new Date(d).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Checked today";
  if (days === 1) return "Checked yesterday";
  if (days < 30) return `Checked ${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "Checked 1 month ago";
  return `Checked ${months} months ago`;
}

// Human-facing status shown in the end-of-run recap.
const STATUS_LABEL: Record<StopStatus, string> = {
  pending: "Not surveyed",
  confirm: "Working",
  broken: "Broken",
  out_of_order: "Out of order",
  removed: "Removed",
  skipped: "Skipped",
};

// A point's latest queued edit: a later survey of it supersedes the earlier.
function latestEdit(items: OutboxItem[], id: number | string): OutboxItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    if (String(items[i].nodeId) === String(id)) return items[i];
  }
  return undefined;
}

export default function RunScreen() {
  const live = useRunSession();
  // Finish ends the run at once, resetting the stores this screen reads, but
  // the router only replaces the screen on its next render. Until then, and
  // while the summary slides over it, the screen keeps showing the run as it
  // was instead of an empty map and "Waiting for GPS…".
  const [ended, setEnded] = useState<RunSession | null>(null);
  const s = ended ?? live;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [selectedId, setSelectedId] = useState<number | string | null>(null);
  const [addLocation, setAddLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [confirm, setConfirm] = useState<{ i: number; action: "end" } | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const pending = confirm && confirm.i === s.index ? confirm.action : null;

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

  const onMarkerPress = (id: number | string) => {
    setSelectedId(id);
  };

  const onMapPress = (lat: number, lon: number) => {
    setAddLocation({ lat, lon });
  };

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

  // Reached with no run to show (a stale link, or the run already ended):
  // back to where runs start.
  if (s.nothingToResume) return <Redirect href="/plan" />;

  if (s.hydrating) {
    return (
      <View className="bg-base flex-1 items-center justify-center">
        <Text className="text-light font-medium">Loading session…</Text>
      </View>
    );
  }

  return (
    <View className="bg-base flex-1">
      <RosmMap
        center={s.center}
        markers={mapMarkers}
        line={s.line}
        userPos={s.userPos}
        recenterKey={s.recenterKey}
        fitPoints={s.fitPoints}
        showLocationButton
        onMarkerPress={onMarkerPress}
        onMapPress={onMapPress}
      />
      {/* A full-screen stack screen, so the root provider's inset is this
          screen's: the panel clears the home indicator and Android's 3-button
          bar (48dp; edge to edge is always on), and keeps at least its own
          32pt below the last button. */}
      <View
        className="bg-base border-light/10 absolute right-0 bottom-0 left-0 border-t px-5 pt-5"
        style={{ paddingBottom: Math.max(32, insets.bottom + 8) }}
      >
        {s.done ? (
          <>
            <Text className="text-light text-lg font-bold">Run complete</Text>
            <Text className="text-light-muted mb-3">
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
                      <Text className="text-light flex-1 text-sm" numberOfLines={1}>
                        {st.tags?.name ?? `node ${st.id}`}
                      </Text>
                      <Text className="text-light-muted text-xs">{STATUS_LABEL[st.status]}</Text>
                    </View>
                  ))}
                  {s.added.map((f) => (
                    <View key={f.id} className="flex-row items-center gap-2">
                      <View
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: "#16a34a" }}
                      />
                      <Text className="text-light flex-1 text-sm" numberOfLines={1}>
                        {f.tags?.name ?? `node ${f.id}`}
                      </Text>
                      <Text className="text-light-muted text-xs">Added</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : (
              <Text className="text-light-muted mb-4 text-sm">
                No points surveyed. Finish to save your route.
              </Text>
            )}
            <Button title="Finish run" variant="blue" onPress={handleFinish} />
          </>
        ) : s.target ? (
          <>
            <Text className="text-light text-lg font-bold">
              {s.target.tags?.name ??
                (s.nextTurn
                  ? `${maneuver(s.nextTurn.angle)} in ${fmtDist(s.distToTurn ?? 0)}`
                  : "Next stop")}
            </Text>
            <Text className="text-light-muted">{checkedAgoLabel(s.target.tags, now)}</Text>

            {s.target.tags?.drinking_water === "no" ? (
              <View className="flex-row items-center gap-1.5">
                <DogIcon size={16} color="#a78bfa" />
                <Text className="text-sm font-medium text-violet-400">
                  Dog water — not for humans
                </Text>
              </View>
            ) : null}

            {s.osm && !s.osm.loggedIn ? (
              <Text className="text-light-muted text-xs">
                Sign in (Profile tab) to record updates.
              </Text>
            ) : null}

            {pending === "end" ? (
              <View className="gap-2">
                <Text className="text-light text-sm font-medium">
                  End this route early? Remaining stops will be left for next time.
                </Text>
                <View className="flex-row gap-2">
                  <View className="flex-1">
                    <Button title="Cancel" variant="ghost-dark" onPress={() => setConfirm(null)} />
                  </View>
                  <View className="flex-1">
                    <Button
                      title="End route"
                      onPress={() => {
                        setConfirm(null);
                        s.endEarly();
                      }}
                    />
                  </View>
                </View>
              </View>
            ) : (
              <View className="gap-6 pt-5 pb-3">
                <Button
                  title="I'm here"
                  variant="blue"
                  size="lg"
                  onPress={() => {
                    s.setManualArrived(true);
                    if (s.target) setSelectedId(s.target.id);
                  }}
                />
                <View className="flex-row gap-3">
                  <Pressable
                    onPress={() => setConfirm({ i: s.index, action: "end" })}
                    accessibilityRole="button"
                    accessibilityLabel="End route early"
                    className="flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-950/20 px-4 py-5"
                  >
                    <XCircleIcon size={24} color="#f87171" />
                    <Text className="text-base font-bold text-red-400">End</Text>
                  </Pressable>
                  {s.index > 0 ? (
                    <Pressable
                      onPress={() => s.goBack()}
                      accessibilityRole="button"
                      accessibilityLabel="Back to previous stop"
                      className="border-light/25 flex-1 flex-row items-center justify-center gap-2 rounded-xl border px-4 py-5"
                    >
                      <SkipBackIcon size={24} color="#f7f2e8" />
                      <Text className="text-light text-base font-semibold">Back</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => s.skip()}
                    accessibilityRole="button"
                    accessibilityLabel="Skip this stop"
                    className="border-light/25 flex-1 flex-row items-center justify-center gap-2 rounded-xl border px-4 py-5"
                  >
                    <SkipForwardIcon size={24} color="#f7f2e8" />
                    <Text className="text-light text-base font-semibold">Skip</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </>
        ) : (
          <Text className="text-light-muted">Waiting for GPS…</Text>
        )}

        {s.lastSaved ? (
          <View className="flex-row items-center gap-2">
            <CheckCircleIcon size={16} color="#4ade80" />
            <Text className="flex-1 text-sm text-green-300">Saved · {s.lastSaved.label}</Text>
          </View>
        ) : null}
        {s.err ? <Text className="text-red-400">{s.err}</Text> : null}
      </View>

      <PointSheetHost isPresented={selectedId != null} onDismiss={() => setSelectedId(null)}>
        {selectedPoint ? (
          <PointSheet
            fountain={selectedPoint}
            edit={selectedEdit}
            onAction={(action, extras) => {
              s.recordFor(selectedPoint, action, extras);
              setSelectedId(null);
            }}
          />
        ) : null}
      </PointSheetHost>

      <PointSheetHost isPresented={addLocation != null} onDismiss={() => setAddLocation(null)}>
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
            onAction={async (_action, extras) => {
              await s.addAt(addLocation, extras);
              setAddLocation(null);
            }}
          />
        ) : null}
      </PointSheetHost>
    </View>
  );
}
