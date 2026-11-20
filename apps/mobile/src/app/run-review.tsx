import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { TrashIcon } from "phosphor-react-native/src/icons/Trash";
import { WarningIcon } from "phosphor-react-native/src/icons/Warning";
import { SafeArea } from "../components/ui/SafeArea";
import { Button } from "../components/ui/Button";
import { PointSheetHost } from "../components/ui/PointSheetHost";
import { confirmDestructive } from "../components/ui/confirm";
import { PointSheet, type SurveyAction } from "../components/PointSheet";
import { WaterRunMap, type MapMarker } from "../map/WaterRunMap";
import { useSignedIn } from "../auth/useSignedIn";
import { promptSignIn } from "../auth/SignInButton";
import { announce } from "../ports/accessibility";
import { hapticSelect, hapticSuccess } from "../ports/haptics";
import { getArchivedRoute } from "@water-run/core/routeArchive";
import { EDIT_COLOR } from "@water-run/core/editStatus";
import type { EditExtras, Fountain } from "@water-run/core/schemas";
import {
  itemFor,
  problemFor,
  useProposals,
  type ProposedItem,
} from "@water-run/core/stores/proposals";

const NEW_COLOR = "#16a34a";

// What each answer says in the list.
const ACTION_LABEL: Record<SurveyAction, string> = {
  confirm: "Working",
  broken: "Partially working",
  out_of_order: "Out of order",
  removed: "Removed",
};

const AUDIENCE_LABEL = { humans: "For people", dogs: "For dogs", both: "People and dogs" };
const DISPENSER_LABEL = { bubbler: "Bubbler", bottle: "Bottle filler", both: "Bubbler + bottle" };

// The survey details an update carries, in words.
function detailsOf(extras: EditExtras | undefined): string[] {
  if (!extras) return [];
  const out: string[] = [];
  if (extras.audience) out.push(AUDIENCE_LABEL[extras.audience]);
  if (extras.dispenser) out.push(DISPENSER_LABEL[extras.dispenser]);
  if (extras.seasonal) out.push("Seasonal");
  if (extras.note) out.push(`“${extras.note}”`);
  return out;
}

const labelOf = (i: ProposedItem) =>
  i.kind === "create" ? "New fountain" : ACTION_LABEL[i.action];
const colorOf = (i: ProposedItem) =>
  i.kind === "create" ? NEW_COLOR : (EDIT_COLOR[i.action] ?? NEW_COLOR);

// The end-of-run step between finishing and OSM: every update the run made,
// held on the phone, to check, correct or drop before it is all sent as one
// changeset. Reached from Finish, from the planner's End Run, and from Profile
// for a run left unsent. Leaving it keeps everything for later.
export default function RunReview() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const signedIn = useSignedIn();
  const proposal = useProposals((s) => s.byRoute[id]);
  const hydrated = useProposals((s) => s.hydrated);
  useEffect(() => {
    if (!useProposals.getState().hydrated) useProposals.getState().hydrate();
  }, []);
  // The run itself, for the map's route line and each stop's OSM tags.
  const route = useMemo(() => getArchivedRoute(id), [id]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const items = useMemo(() => proposal?.items ?? [], [proposal]);
  const busy = sending || proposal?.state === "submitting";

  // Where each update's point is and what OSM said about it: held with the
  // update, or else from the run's stops.
  const fountainOf = useMemo(() => {
    const stops = new Map((route?.plan.stops ?? []).map((s) => [s.id, s]));
    return (i: ProposedItem): Fountain | null => {
      if (i.kind === "create") {
        return { id: i.tempId, lat: i.lat, lon: i.lon, tags: { [i.tag.key]: i.tag.value } };
      }
      const at = i.point ?? stops.get(i.nodeId);
      return at ? { id: i.nodeId, lat: at.lat, lon: at.lon, tags: at.tags ?? {} } : null;
    };
  }, [route]);

  const markers: MapMarker[] = useMemo(
    () =>
      items.flatMap((i) => {
        const f = fountainOf(i);
        return f
          ? [
              {
                id: f.id,
                lat: f.lat,
                lon: f.lon,
                color: colorOf(i),
                label: i.kind === "create" ? "+" : undefined,
              },
            ]
          : [];
      }),
    [items, fountainOf],
  );
  const fit = useMemo(() => markers.map((m): [number, number] => [m.lat, m.lon]), [markers]);
  const line: [number, number][] = useMemo(
    () => (route?.plan.routeCoords ?? []).map(([lon, lat]) => [lat, lon]),
    [route],
  );

  const selected = selectedKey ? items.find((i) => i.key === selectedKey) : undefined;
  const selectedFountain = selected ? fountainOf(selected) : null;

  if (!hydrated) return <SafeArea className="bg-surface flex-1" />;
  // Already sent (or nothing held): the run's summary says what happened.
  if (!proposal || proposal.state === "submitted" || items.length === 0) {
    return route ? (
      <Redirect href={{ pathname: "/run-detail", params: { id } }} />
    ) : (
      <Redirect href="/quick-update" />
    );
  }

  const change = (item: ProposedItem, action: SurveyAction, extras?: EditExtras) => {
    const store = useProposals.getState();
    if (item.kind === "create" && action === "removed") store.remove(id, item.key);
    else store.update(id, item.key, item.kind === "edit" ? { action, extras } : { extras });
    setSelectedKey(null);
    hapticSuccess();
    announce("Update changed.");
  };

  const drop = (item: ProposedItem) =>
    confirmDestructive({
      title: item.kind === "create" ? "Don't add this fountain?" : "Remove this update?",
      message: "It won't be sent to the map.",
      confirm: "Remove",
      onConfirm: () => {
        useProposals.getState().remove(id, item.key);
        hapticSelect();
        announce("Update removed.");
      },
    });

  const send = async () => {
    if (busy) return;
    if (!signedIn) {
      promptSignIn({
        title: "Sign in to send your updates",
        message:
          "Your updates go to OpenStreetMap, the free public map Water Run saves to, so sending them needs an OpenStreetMap account. They stay on this phone until then.",
      });
      return;
    }
    setSending(true);
    const out = await useProposals.getState().submit(id);
    setSending(false);
    if (out.ok) {
      hapticSuccess();
      announce("Updates sent to the map.");
      router.replace({ pathname: "/run-detail", params: { id, fresh: "1" } });
      return;
    }
    announce(out.message);
  };

  const saveForLater = () => {
    announce("Saved. Send them any time from Profile.");
    router.replace("/quick-update");
  };

  const discard = () =>
    confirmDestructive({
      title: "Discard this run's updates?",
      message: `${items.length} ${items.length === 1 ? "update" : "updates"} will be deleted from this phone and never sent.`,
      confirm: "Discard Updates",
      onConfirm: () => {
        useProposals.getState().discard(id);
        router.replace(route ? { pathname: "/run-detail", params: { id } } : "/quick-update");
      },
    });

  return (
    <SafeArea className="bg-surface flex-1" edges={["top", "bottom"]}>
      <View className="h-2/5">
        <WaterRunMap
          center={markers[0] ? [markers[0].lat, markers[0].lon] : [20, 0]}
          markers={markers}
          line={line}
          fitPoints={fit}
          onMarkerPress={(markerId) => {
            const item = itemFor(proposal, markerId);
            if (item && !busy) setSelectedKey(item.key);
          }}
        />
      </View>
      <ScrollView contentContainerClassName="gap-4 p-5">
        <View className="gap-1">
          <Text accessibilityRole="header" className="text-2xl text-base font-bold">
            Review Your Updates
          </Text>
          <Text className="text-muted text-callout">
            {items.length} {items.length === 1 ? "update" : "updates"}, saved on this phone. Tap one
            to change it. Nothing goes to the map until you send.
          </Text>
        </View>

        <View className="gap-2">
          {items.map((item) => {
            const name =
              item.name ?? (item.kind === "create" ? "New fountain" : "Unnamed fountain");
            const details = detailsOf(item.extras);
            const problem = problemFor(proposal, item.key);
            return (
              <View key={item.key} className="flex-row items-center gap-2">
                <Pressable
                  disabled={busy}
                  onPress={() => setSelectedKey(item.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`${name}, ${labelOf(item)}${
                    details.length ? `, ${details.join(", ")}` : ""
                  }${problem ? `. ${problem}` : ""}. Change`}
                  className="border-border bg-surface-deep flex-1 flex-row items-center gap-3 rounded-2xl border px-4 py-3 active:opacity-70"
                >
                  <View
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: colorOf(item) }}
                  />
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text className="text-callout text-base font-semibold" numberOfLines={1}>
                      {name}
                    </Text>
                    <Text className="text-muted text-sm" numberOfLines={2}>
                      {[labelOf(item), ...details].join(" · ")}
                    </Text>
                    {problem ? (
                      <View className="flex-row items-center gap-1">
                        <WarningIcon size={14} color="#b91c1c" weight="fill" />
                        <Text className="flex-1 text-sm font-semibold text-red-700">{problem}</Text>
                      </View>
                    ) : null}
                  </View>
                </Pressable>
                <Pressable
                  disabled={busy}
                  onPress={() => drop(item)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove update for ${name}`}
                  hitSlop={8}
                  className="h-11 w-11 items-center justify-center rounded-full active:opacity-70"
                >
                  <TrashIcon size={22} color="#b91c1c" />
                </Pressable>
              </View>
            );
          })}
        </View>

        {proposal.error ? (
          <Text className="text-callout font-semibold text-red-700">{proposal.error}</Text>
        ) : null}

        <View className="mt-1 gap-3">
          <Button
            title={proposal.error ? "Try Again" : "Send to the Map"}
            variant="action"
            size="lg"
            loading={busy}
            disabled={busy}
            onPress={() => void send()}
          />
          <Button
            title="Save for Later"
            variant="secondary"
            disabled={busy}
            onPress={saveForLater}
          />
          <Button title="Discard Updates" variant="danger" disabled={busy} onPress={discard} />
        </View>
      </ScrollView>

      <PointSheetHost isPresented={!!selected} onDismiss={() => setSelectedKey(null)}>
        {selected && selectedFountain ? (
          <View className="gap-2">
            {selected.kind === "edit" ? (
              <Text className="text-muted text-sm font-semibold">
                Recorded: {[labelOf(selected), ...detailsOf(selected.extras)].join(" · ")}
              </Text>
            ) : null}
            {/* No `edit` passed: the sheet opens on its survey steps, so the
                answer itself can be changed, not only its details. */}
            <PointSheet
              fountain={selectedFountain}
              newPointLabel="Save Details"
              onAction={(action, extras) => change(selected, action, extras)}
            />
          </View>
        ) : null}
      </PointSheetHost>
    </SafeArea>
  );
}
