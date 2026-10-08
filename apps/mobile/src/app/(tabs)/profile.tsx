import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Image } from "expo-image";
import { withUniwind } from "uniwind";
import { useFocusEffect, useIsFocused, useRouter } from "expo-router";
import { SafeArea } from "../../components/ui/SafeArea";
import { getArchivedRouteIndex, type ArchivedRouteSummary } from "@rosm/core/routeArchive";
import { fmtDist } from "@rosm/core/geo";
import { useOsmStatus } from "../../auth/useOsmStatus";
import { useOsmUser } from "../../auth/useOsmUser";
import { signOutOsm } from "../../auth/osmAuth";
import { Button } from "../../components/ui/Button";
import { Panel } from "../../components/ui/Panel";

// expo-image isn't a core RN component, so Uniwind doesn't wire `className` →
// `style` for it out of the box. Wrap once so Tailwind classes apply.
const StyledImage = withUniwind(Image);

// True from the first time this tab is shown. Native tabs render every tab at
// launch (expo-router has no lazy option), and this one would otherwise fetch
// the OSM account and read the run archive behind the landing tab.
function useOpenedOnce(): boolean {
  const focused = useIsFocused();
  const [opened, setOpened] = useState(focused);
  if (focused && !opened) setOpened(true);
  return opened;
}

// Who you are on OSM, your run history, and the way out — a mirror of the web
// AccountCard. Sign-out clears the keychain token; the router auth gate then flips
// to the login screen.
export default function Profile() {
  return useOpenedOnce() ? <ProfileContent /> : <View className="bg-surface flex-1" />;
}

function ProfileContent() {
  const router = useRouter();
  const { status } = useOsmStatus();
  const user = useOsmUser();
  // Read from the archive's small index, not the runs themselves, and again
  // each time the tab is shown, so a run finished since is listed.
  const [routes, setRoutes] = useState<ArchivedRouteSummary[]>(getArchivedRouteIndex);
  useFocusEffect(useCallback(() => setRoutes(getArchivedRouteIndex()), []));
  const totalSurveyed = routes.reduce((n, r) => n + r.surveyedCount, 0);

  return (
    <SafeArea className="bg-surface flex-1" edges={["top", "bottom"]}>
      <ScrollView contentContainerClassName="gap-4 p-5">
        <Text className="text-3xl text-base font-bold">Profile</Text>
        <Panel>
          <View className="flex-row items-center gap-4">
            {user?.avatarUrl ? (
              <StyledImage
                source={{ uri: user.avatarUrl }}
                className="bg-surface-deep h-16 w-16 rounded-full"
                contentFit="cover"
                cachePolicy="memory-disk"
                transition={150}
              />
            ) : (
              <View className="bg-surface-deep h-16 w-16 items-center justify-center rounded-full">
                <Text className="text-muted text-xl font-bold">
                  {(user?.username ?? "?").slice(0, 1).toUpperCase()}
                </Text>
              </View>
            )}
            <View className="min-w-0 flex-1">
              <View className="flex-row items-center gap-2">
                <View className="h-2 w-2 rounded-full bg-green-500" />
                <Text className="flex-1 text-base text-lg font-bold" numberOfLines={1}>
                  {user?.username ?? (status?.loggedIn ? "Connected to OSM" : "Not connected")}
                </Text>
              </View>
              {status && !status.live ? (
                <Text className="mt-0.5 text-xs font-semibold text-amber-600">Sandbox</Text>
              ) : null}
            </View>
          </View>
        </Panel>

        {user ? (
          <Panel>
            <View className="border-border flex-row items-center justify-between border-b py-2.5">
              <Text className="text-muted">Lifetime contributions</Text>
              <Text className="text-base font-bold">{user.changesetCount}</Text>
            </View>
            {user.accountCreated ? (
              <View className="flex-row items-center justify-between py-2.5">
                <Text className="text-muted">Member since</Text>
                <Text className="text-base font-bold">
                  {new Date(user.accountCreated).toLocaleDateString()}
                </Text>
              </View>
            ) : null}
          </Panel>
        ) : null}

        <Panel>
          <Text className="mb-1 text-base font-bold">Your runs</Text>
          <Text className="text-muted mb-3 text-sm">
            {routes.length} {routes.length === 1 ? "run" : "runs"} · {totalSurveyed} points surveyed
          </Text>
          {routes.length === 0 ? (
            <Text className="text-muted text-sm">No runs yet — plan your first route.</Text>
          ) : (
            routes.slice(0, 10).map((r) => (
              <Pressable
                key={r.routeId}
                onPress={() => router.push({ pathname: "/run-detail", params: { id: r.routeId } })}
                className="border-border border-t py-2.5"
              >
                <Text className="text-base">
                  {new Date(r.updatedAt).toLocaleDateString()} · {fmtDist(r.distanceM)} ·{" "}
                  {r.stopCount} stops
                </Text>
              </Pressable>
            ))
          )}
        </Panel>

        <Button
          title="Sign out"
          variant="ghost"
          onPress={async () => {
            await signOutOsm();
          }}
        />
      </ScrollView>
    </SafeArea>
  );
}
