// Web PWA identity (app/manifest.ts), re-exported from the shared @rosm/core
// source so web and the Expo app agree on names/colors.
import cfg from "@rosm/core/appConfig.json";

export const APP_NAME = cfg.appName;
export const APP_TAGLINE = cfg.appTagline;
export const PWA_THEME_COLOR = cfg.pwaThemeColor;
// The mobile app's deep-link scheme. Native OSM sign-in hands the token back
// through it, so it must be the one the app registers. It stays "rosm" after
// the rename: changing it breaks sign-in on every installed build.
export const SCHEME = cfg.scheme;
// Store/download link for the mobile app. Empty until the app is published —
// fill in the App Store / Play Store URL here (single source in appConfig.json).
export const APP_STORE_URL = cfg.appStoreUrl || "#";
