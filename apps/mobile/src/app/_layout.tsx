import "../global.css";
import "../tasks/runLocationTask"; // registers the background location task at launch
import { useEffect } from "react";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import cfg from "@water-run/core/appConfig.json";
import { configureMobilePorts } from "../ports";
import { useAuth } from "../auth/useAuth";
import { ConfettiHost } from "../ports/confetti";
import { OutboxSyncBridge } from "../components/OutboxSyncBridge";
import { settleRunAtLaunch } from "../run/runLifecycle";

// Wire @water-run/core to the Expo adapters once, before any screen renders, then
// clear up after a run the app died in the middle of.
configureMobilePorts();
settleRunAtLaunch();
SplashScreen.preventAutoHideAsync();

// No sign-in gate: Nearby, the planner and a run all work signed out. Edits
// made off a run wait in the outbox for a token, and a run's updates wait on
// the phone for its review (HIG: Managing accounts, "Delay sign-in for as long
// as possible"). Sign-in is offered where it's needed: Profile, a saved edit,
// adding a fountain off a run, sending a run. The splash still waits on
// the keychain read, so the first screen already knows who is signed in.
export default function RootLayout() {
  const { ready } = useAuth();

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null; // keep the splash up until the keychain read resolves

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: cfg.colors.surface },
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="run" />
          <Stack.Screen name="run-review" />
          <Stack.Screen name="run-detail" />
        </Stack>
        <ConfettiHost />
        <OutboxSyncBridge />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
