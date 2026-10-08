import type { ExpoConfig } from "expo/config";

// Shared identity from @water-run/core. A relative require (not a package import) keeps
// the Expo config loader happy across the pnpm workspace symlink.
const cfg = require("../../packages/core/appConfig.json");

const config: ExpoConfig = {
  name: cfg.appName,
  slug: "water-run",
  version: "1.0.0",
  scheme: cfg.scheme, // registers waterrun:// for the OSM OAuth deep-link callback
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: false,
    bundleIdentifier: cfg.appId,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // Background location so a run keeps tracking with the screen locked.
      UIBackgroundModes: ["location"],
      NSLocationWhenInUseUsageDescription:
        "Water Run shows your position on the map and guides you to each survey point.",
      NSLocationAlwaysAndWhenInUseUsageDescription:
        "During an active run Water Run keeps recording your route and guiding you even when the screen is locked. Location is never collected outside an active run.",
    },
  },
  android: {
    package: cfg.appId,
    permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "ACCESS_BACKGROUND_LOCATION"],
  },
  plugins: [
    "expo-router",
    "@maplibre/maplibre-react-native",
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "Water Run shows your position on the map and guides you to each survey point.",
        locationAlwaysAndWhenInUsePermission:
          "During an active run Water Run keeps recording your route and guiding you even when the screen is locked.",
        isAndroidBackgroundLocationEnabled: true,
      },
    ],
    "expo-notifications",
    "expo-secure-store",
    "expo-sqlite",
    "expo-sharing",
    "expo-font",
    "expo-image",
    "expo-status-bar",
    "expo-web-browser",
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 180,
      },
    ],
  ],
  experiments: { typedRoutes: true },
  // No EAS project yet: the old one was bound to the slug "rosm". Run `eas init`
  // (logged in) once to create the water-run project; it writes
  // extra.eas.projectId here.
};

export default config;
