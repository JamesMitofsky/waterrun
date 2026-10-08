import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { SafeArea } from "../components/ui/SafeArea";
import { getArchivedRoutes } from "@rosm/core/routeArchive";
import { STATUS_COLOR } from "@rosm/core/editStatus";
import { RosmMap, type RosmMarker } from "../map/RosmMap";
import { fmtDist } from "@rosm/core/geo";
import { Button } from "../components/ui/Button";

// Read-only replay of one archived run — validates the archive schema end-to-end.
export default function RunDetail() {
  const { id, fresh } = useLocalSearchParams<{ id: string; fresh?: string }>();
  const router = useRouter();
  // `fresh` is set only when arriving straight from finishing a run — the live
  // session state is gone, so this snapshot is the last chance to screenshot.
  const justFinished = fresh === "1";
  const route = getArchivedRoutes().find((r) => r.routeId === id);

  if (!route) {
    return (
      <SafeArea className="bg-surface flex-1 items-center justify-center gap-4 px-6">
        <Text className="text-base">Run not found.</Text>
        <Button title="Back" onPress={() => router.back()} />
      </SafeArea>
    );
  }

  const { plan } = route;
  const added = plan.added ?? [];
  const surveyed = plan.stops.filter((s) => s.status !== "pending" && s.status !== "skipped");
  const stopMarkers: RosmMarker[] = plan.stops.map((s, i) => ({
    id: s.id,
    lat: s.lat,
    lon: s.lon,
    color: STATUS_COLOR[s.status],
    label: String(i + 1),
  }));
  const addedMarkers: RosmMarker[] = added.map((f) => ({
    id: f.id,
    lat: f.lat,
    lon: f.lon,
    color: "#16a34a",
    label: "+",
  }));
  const markers = [...stopMarkers, ...addedMarkers];
  const line: [number, number][] = plan.routeCoords.map(([lon, lat]) => [lat, lon]);
  const fit = plan.stops.map((s): [number, number] => [s.lat, s.lon]);

  return (
    <SafeArea className="bg-surface flex-1" edges={["bottom"]}>
      <View className="h-1/2">
        <RosmMap
          center={[plan.start.lat, plan.start.lon]}
          markers={markers}
          line={line}
          fitPoints={fit}
        />
      </View>
      <ScrollView contentContainerClassName="gap-2 p-5">
        <Text className="text-base text-xl font-bold">
          {new Date(route.updatedAt).toLocaleString()}
        </Text>
        <Text className="text-muted">
          {fmtDist(plan.distanceM)} · {surveyed.length + added.length} of {plan.stops.length}{" "}
          surveyed
        </Text>
        {plan.stops.map((s, i) => (
          <Text key={s.id} className="text-base">
            {i + 1}. {s.tags?.name ?? `node ${s.id}`} — {s.status}
          </Text>
        ))}
        {added.map((f) => (
          <Text key={f.id} className="text-base">
            + {f.tags?.name ?? `node ${f.id}`} — added
          </Text>
        ))}
        {justFinished ? (
          <Text className="text-muted mt-3 text-sm">
            This route will disappear once you leave this screen. If you want any Strava-evidence,
            now&apos;s the time to screenshot!
          </Text>
        ) : null}
        <View className="mt-3">
          {justFinished ? (
            <Button
              title="Return home"
              variant="secondary"
              onPress={() => router.replace("/quick-update")}
            />
          ) : (
            <Button title="Back" variant="secondary" onPress={() => router.back()} />
          )}
        </View>
      </ScrollView>
    </SafeArea>
  );
}
