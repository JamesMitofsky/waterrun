import { useMemo } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { ArrowSquareOutIcon } from "phosphor-react-native/src/icons/ArrowSquareOut";
import { useProposals } from "@water-run/core/stores/proposals";
import { SafeArea } from "../components/ui/SafeArea";
import { getArchivedRoute } from "@water-run/core/routeArchive";
import { STATUS_COLOR } from "@water-run/core/editStatus";
import type { StopStatus } from "@water-run/core/stores/run";
import { WaterRunMap, type MapMarker } from "../map/WaterRunMap";
import { fmtDist } from "@water-run/core/geo";
import { Button } from "../components/ui/Button";

// How each stop ended, in words; the raw status keys never reach the screen.
const STATUS_LABEL: Record<StopStatus, string> = {
  pending: "Not reached",
  confirm: "Working",
  broken: "Partially working",
  out_of_order: "Out of order",
  removed: "Removed",
  skipped: "Skipped",
};

// The number's colour on each status dot: dark on the light fills (grey,
// amber), where white falls under 3:1.
const DOT_INK: Record<StopStatus, string> = {
  pending: "text-base",
  confirm: "text-white",
  broken: "text-base",
  out_of_order: "text-base",
  removed: "text-white",
  skipped: "text-white",
};

// The summary of one archived run (HIG: Workouts, "Provide a summary at the
// end of a session"): straight after finishing, and from Profile's history.
export default function RunDetail() {
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const router = useRouter();
  // `fresh` is set only when arriving straight from finishing a run.
  const justFinished = fresh === "1";
  // This one run, read once: not the whole archive, and not on every render.
  const route = useMemo(() => getArchivedRoute(id), [id]);
  // The run's updates: held for review, or sent (with their changeset).
  const proposal = useProposals((s) => s.byRoute[id]);
  const awaiting = !!proposal && proposal.state !== "submitted" && proposal.items.length > 0;
  const sentUrl = proposal?.result?.changesetUrl;

  if (!route) {
    return (
      <SafeArea className="bg-surface flex-1 items-center justify-center gap-4 px-6">
        <Text className="text-base text-lg">This run couldn&apos;t be found.</Text>
        <Button title="Back" variant="secondary" onPress={() => router.back()} />
      </SafeArea>
    );
  }

  const { plan } = route;
  const added = plan.added ?? [];
  const surveyed = plan.stops.filter((s) => s.status !== "pending" && s.status !== "skipped");
  const stopMarkers: MapMarker[] = plan.stops.map((s, i) => ({
    id: s.id,
    lat: s.lat,
    lon: s.lon,
    color: STATUS_COLOR[s.status],
    label: String(i + 1),
  }));
  const addedMarkers: MapMarker[] = added.map((f) => ({
    id: f.id,
    lat: f.lat,
    lon: f.lon,
    color: "#16a34a",
    label: "+",
  }));
  const markers = [...stopMarkers, ...addedMarkers];
  const line: [number, number][] = plan.routeCoords.map(([lon, lat]) => [lat, lon]);
  const fit = plan.stops.map((s): [number, number] => [s.lat, s.lon]);
  const when = new Date(route.updatedAt).toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <SafeArea className="bg-surface flex-1" edges={["bottom"]}>
      <View className="h-1/2">
        <WaterRunMap
          center={[plan.start.lat, plan.start.lon]}
          markers={markers}
          line={line}
          fitPoints={fit}
        />
      </View>
      <ScrollView contentContainerClassName="gap-3 p-5">
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-2xl text-base font-bold">
            {justFinished ? (sentUrl ? "Updates Sent" : "Run Saved") : when}
          </Text>
          <Text className="text-muted text-callout">
            {justFinished ? `${when} · ` : ""}
            {fmtDist(plan.distanceM)} · {surveyed.length + added.length} of {plan.stops.length}{" "}
            surveyed
          </Text>
        </View>
        <View className="gap-2">
          {plan.stops.map((s, i) => (
            <View
              key={s.id}
              className="flex-row items-center gap-3"
              accessible
              accessibilityLabel={[`Stop ${i + 1}`, s.tags?.name, STATUS_LABEL[s.status]]
                .filter(Boolean)
                .join(", ")}
            >
              <View
                className="h-6 w-6 items-center justify-center rounded-full"
                style={{ backgroundColor: STATUS_COLOR[s.status] }}
              >
                <Text className={`text-xs font-bold ${DOT_INK[s.status]}`}>{i + 1}</Text>
              </View>
              {/* Few fountains are named: an unnamed one is just its number
                  and status. */}
              {s.tags?.name ? (
                <>
                  <Text className="text-callout flex-1 text-base" numberOfLines={1}>
                    {s.tags.name}
                  </Text>
                  <Text className="text-muted text-sm">{STATUS_LABEL[s.status]}</Text>
                </>
              ) : (
                <Text className="text-callout flex-1 text-base">{STATUS_LABEL[s.status]}</Text>
              )}
            </View>
          ))}
          {added.map((f) => (
            <View key={f.id} className="flex-row items-center gap-3">
              <View className="h-6 w-6 items-center justify-center rounded-full bg-green-600">
                <Text className="text-xs font-bold text-white">+</Text>
              </View>
              <Text className="text-callout flex-1 text-base" numberOfLines={1}>
                {f.tags?.name ?? "New fountain"}
              </Text>
              <Text className="text-muted text-sm">Added</Text>
            </View>
          ))}
        </View>
        {awaiting ? (
          <View className="gap-2">
            <Text className="text-muted text-sm">
              {proposal.items.length} {proposal.items.length === 1 ? "update is" : "updates are"}{" "}
              saved on this phone and not sent yet.
            </Text>
            <Button
              title="Review & Send"
              variant={justFinished ? "secondary" : "action"}
              onPress={() => router.push({ pathname: "/run-review", params: { id } })}
            />
          </View>
        ) : null}
        {sentUrl ? (
          <Pressable
            onPress={() => void Linking.openURL(sentUrl)}
            accessibilityRole="link"
            hitSlop={12}
            className="flex-row items-center gap-1 self-start"
          >
            <ArrowSquareOutIcon size={16} color="#1877a3" />
            <Text className="text-action text-sm font-bold">View Online</Text>
          </Pressable>
        ) : null}
        {justFinished ? (
          <Text className="text-muted text-sm">This run is saved under Your Runs in Profile.</Text>
        ) : null}
        <View className="mt-2">
          {justFinished ? (
            <Button title="Done" variant="action" onPress={() => router.replace("/quick-update")} />
          ) : (
            <Button title="Back" variant="secondary" onPress={() => router.back()} />
          )}
        </View>
      </ScrollView>
    </SafeArea>
  );
}
