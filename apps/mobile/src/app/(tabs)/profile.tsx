import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { withUniwind } from "uniwind";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { CaretRightIcon } from "phosphor-react-native/src/icons/CaretRight";
import { SafeArea } from "../../components/ui/SafeArea";
import { getArchivedRouteIndex, type ArchivedRouteSummary } from "@water-run/core/routeArchive";
import { fmtDist } from "@water-run/core/geo";
import { outboxCounts, useOutbox } from "@water-run/core/stores/outbox";
import { heldCount, useProposals, waitingForReview } from "@water-run/core/stores/proposals";
import { useOsmStatus } from "../../auth/useOsmStatus";
import { useOsmUser } from "../../auth/useOsmUser";
import { useSignedIn } from "../../auth/useSignedIn";
import { signOutOsm } from "../../auth/osmAuth";
import { SignInButton } from "../../auth/SignInButton";
import { Button } from "../../components/ui/Button";
import { Panel } from "../../components/ui/Panel";
import { confirmDestructive } from "../../components/ui/confirm";

// expo-image isn't a core RN component, so Uniwind doesn't wire `className` →
// `style` for it out of the box. Wrap once so Tailwind classes apply.
const StyledImage = withUniwind(Image);

// How many past runs the list shows before "Show All".
const RUNS_SHOWN = 10;

// True from the first time this tab is shown. Native tabs render every tab at
// launch (expo-router has no lazy option), and this one would otherwise fetch
// the OSM account and read the run archive behind the landing tab.
function useOpenedOnce(): boolean {
  const focused = useIsFocused();
  const [opened, setOpened] = useState(focused);
  if (focused && !opened) setOpened(true);
  return opened;
}

// Who you are on OSM, your run history, and the way in or out — a mirror of
// the web AccountCard. Signed out, it is where sign-in lives.
export default function Profile() {
  return useOpenedOnce() ? <ProfileContent /> : <View className="bg-surface flex-1" />;
}

function ProfileContent() {
  const router = useRouter();
  const { status } = useOsmStatus();
  const user = useOsmUser();
  const signedIn = useSignedIn();
  // Updates not on OSM yet: queued in the outbox (made off a run), and held
  // for a run's review.
  const queued = useOutbox((s) => outboxCounts(s.items).unsent);
  const byRoute = useProposals((s) => s.byRoute);
  const held = heldCount(byRoute);
  const unsent = queued + held;
  const toReview = useMemo(() => waitingForReview(byRoute), [byRoute]);
  const unsentRuns = useMemo(() => new Set(toReview.map((p) => p.routeId)), [toReview]);
  // Read from the archive's small index, not the runs themselves, and again
  // each time the tab is shown, so a run finished since is listed.
  const [routes, setRoutes] = useState<ArchivedRouteSummary[]>(getArchivedRouteIndex);
  const [showAll, setShowAll] = useState(false);
  useFocusEffect(useCallback(() => setRoutes(getArchivedRouteIndex()), []));
  const totalSurveyed = routes.reduce((n, r) => n + r.surveyedCount, 0);
  const shown = showAll ? routes : routes.slice(0, RUNS_SHOWN);

  // Signing out with updates still waiting doesn't lose them (they wait for
  // the next sign-in), but it does stop them, which nobody would expect
  // (HIG: Feedback, warn before an unexpected loss).
  const signOut = () => {
    if (unsent === 0) {
      void signOutOsm();
      return;
    }
    confirmDestructive({
      title: "Sign out?",
      message: `${unsent} ${unsent === 1 ? "update hasn't" : "updates haven't"} been sent yet. ${
        unsent === 1 ? "It stays" : "They stay"
      } on this phone${
        held > 0
          ? ", and runs waiting for review can be sent after you sign in again."
          : " and go out when you sign in again."
      }`,
      confirm: "Sign Out",
      onConfirm: () => void signOutOsm(),
    });
  };

  return (
    <SafeArea className="bg-surface flex-1" edges={["top", "bottom"]}>
      <ScrollView contentContainerClassName="gap-4 p-5 pb-28">
        <Text accessibilityRole="header" className="text-3xl text-base font-bold">
          Profile
        </Text>

        {signedIn ? (
          <Panel>
            <View className="flex-row items-center gap-4">
              {user?.avatarUrl ? (
                <StyledImage
                  source={{ uri: user.avatarUrl }}
                  className="bg-surface-deep h-16 w-16 rounded-full"
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={150}
                  accessibilityIgnoresInvertColors
                />
              ) : (
                <View className="bg-surface-deep h-16 w-16 items-center justify-center rounded-full">
                  <Text className="text-muted text-xl font-bold">
                    {(user?.username ?? "?").slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
              <View className="min-w-0 flex-1">
                <Text className="text-base text-lg font-bold" numberOfLines={1}>
                  {user?.username ?? "Signed in"}
                </Text>
                <Text className="text-muted text-sm">OpenStreetMap account</Text>
                {status && !status.live ? (
                  <Text className="mt-0.5 text-sm font-semibold text-amber-700">
                    Sandbox (test edits only)
                  </Text>
                ) : null}
              </View>
            </View>
          </Panel>
        ) : (
          <Panel className="gap-3">
            <Text className="text-base text-lg font-bold">Send your updates to the map</Text>
            <Text className="text-muted text-callout leading-6">
              Water Run saves fountain updates to OpenStreetMap, the free public map anyone can use.
              Sign in with a free account to send them; until then they stay on this phone.
            </Text>
            {unsent > 0 ? (
              <Text className="text-base text-sm font-semibold">
                {unsent} {unsent === 1 ? "update is" : "updates are"} waiting to be sent.
              </Text>
            ) : null}
            <SignInButton />
          </Panel>
        )}

        {signedIn && user ? (
          <Panel>
            <View className="border-border flex-row items-center justify-between border-b py-2.5">
              <Text className="text-muted text-callout">Lifetime contributions</Text>
              <Text className="text-base font-bold">{user.changesetCount}</Text>
            </View>
            {user.accountCreated ? (
              <View className="flex-row items-center justify-between py-2.5">
                <Text className="text-muted text-callout">Member since</Text>
                <Text className="text-base font-bold">
                  {new Date(user.accountCreated).toLocaleDateString(undefined, {
                    month: "long",
                    year: "numeric",
                  })}
                </Text>
              </View>
            ) : null}
          </Panel>
        ) : null}

        {toReview.length > 0 ? (
          <Panel className="gap-3">
            <Text accessibilityRole="header" className="text-base text-lg font-bold">
              {toReview.length === 1 ? "A run is" : `${toReview.length} runs are`} waiting to be
              sent
            </Text>
            <Text className="text-muted text-callout leading-6">
              Their updates are saved on this phone. Review them and send them to the map.
            </Text>
            {toReview.map((p) => (
              <Button
                key={p.routeId}
                title={`Review ${p.items.length} ${p.items.length === 1 ? "Update" : "Updates"} from ${new Date(
                  p.createdAt,
                ).toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}`}
                variant="action"
                onPress={() => router.push({ pathname: "/run-review", params: { id: p.routeId } })}
              />
            ))}
          </Panel>
        ) : null}

        <Panel>
          <Text accessibilityRole="header" className="mb-1 text-base text-lg font-bold">
            Your Runs
          </Text>
          <Text className="text-muted mb-2 text-sm">
            {routes.length} {routes.length === 1 ? "run" : "runs"} · {totalSurveyed} points surveyed
          </Text>
          {routes.length === 0 ? (
            <Text className="text-muted text-callout">
              No runs yet. Plan one in the Verify tab.
            </Text>
          ) : (
            <>
              {shown.map((r) => {
                const date = new Date(r.updatedAt).toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                });
                return (
                  <Pressable
                    key={r.routeId}
                    onPress={() =>
                      router.push({ pathname: "/run-detail", params: { id: r.routeId } })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`${date}, ${fmtDist(r.distanceM)}, ${r.stopCount} stops${
                      unsentRuns.has(r.routeId) ? ", not sent yet" : ""
                    }`}
                    className="border-border min-h-11 flex-row items-center gap-2 border-t py-3 active:opacity-60"
                  >
                    <Text className="text-callout flex-1 text-base">
                      {date} · {fmtDist(r.distanceM)} · {r.stopCount} stops
                    </Text>
                    {unsentRuns.has(r.routeId) ? (
                      <Text className="text-sm font-semibold text-amber-700">Not sent</Text>
                    ) : null}
                    <CaretRightIcon size={16} color="#4d5c6a" weight="bold" />
                  </Pressable>
                );
              })}
              {routes.length > RUNS_SHOWN && !showAll ? (
                <Pressable
                  onPress={() => setShowAll(true)}
                  accessibilityRole="button"
                  className="border-border min-h-11 justify-center border-t py-3 active:opacity-60"
                >
                  <Text className="text-action text-callout font-bold">
                    Show All {routes.length} Runs
                  </Text>
                </Pressable>
              ) : null}
            </>
          )}
        </Panel>

        {signedIn ? <Button title="Sign Out" variant="ghost" onPress={signOut} /> : null}
      </ScrollView>
    </SafeArea>
  );
}
