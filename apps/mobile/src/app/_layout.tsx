import "../global.css";
import "../tasks/runLocationTask"; // registers the background location task at launch
import { useEffect } from "react";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import cfg from "@rosm/core/appConfig.json";
import { configureMobilePorts } from "../ports";
import { useAuth } from "../auth/useAuth";
import { ConfettiHost } from "../ports/confetti";
import { OutboxSyncBridge } from "../components/OutboxSyncBridge";
import { settleRunAtLaunch } from "../run/runLifecycle";

// Wire @rosm/core to the Expo adapters once, before any screen renders, then
// clear up after a run the app died in the middle of.
configureMobilePorts();
settleRunAtLaunch();
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { signedIn, ready } = useAuth();

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
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="login" />
          </Stack.Protected>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="run" />
            <Stack.Screen name="run-detail" />
          </Stack.Protected>
        </Stack>
        <ConfettiHost />
        <OutboxSyncBridge />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
