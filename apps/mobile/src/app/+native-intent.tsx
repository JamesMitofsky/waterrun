import type { NativeIntent } from "expo-router";
import { isNativeAuthCallback } from "@water-run/core/nativeAuth";

// Every link the app is opened with passes through here before the router acts
// on it (expo-router's +native-intent).
//
// The OSM sign-in callback, waterrun://osm-callback?token=…, is not a screen: the
// auth session that asked for it reads it, through its own 'url' listener on
// Android (expo-web-browser's openAuthSessionAsync fallback) and natively on
// iOS (ASWebAuthenticationSession). The router listens for the same event, so
// on Android it would open its Unmatched Route screen after every sign-in, with
// the token in the URL it keeps. A null return leaves the app where it is.
export const redirectSystemPath: NativeIntent["redirectSystemPath"] = ({ path }) =>
  isNativeAuthCallback(path) ? null : path;
