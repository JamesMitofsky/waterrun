// The site's identity, re-exported from the shared @water-run/core source so the
// site and the Expo app agree on names/colors.
import cfg from "@water-run/core/appConfig.json";

export const APP_NAME = cfg.appName;
export const APP_TAGLINE = cfg.appTagline;
export const PWA_THEME_COLOR = cfg.pwaThemeColor;
// The mobile app's deep-link scheme. Native OSM sign-in hands the token back
// through it, so it must be the one the app registers.
export const SCHEME = cfg.scheme;
// Store/download link for the mobile app. Empty until the app is published —
// fill in the App Store / Play Store URL here (single source in appConfig.json).
export const APP_STORE_URL = cfg.appStoreUrl || "#";
