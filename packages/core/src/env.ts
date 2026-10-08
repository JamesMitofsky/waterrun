// Safe build-time env access for a universal package. Next, Expo, and Node all
// expose `process.env` (browsers get a bundler shim), but @water-run/core doesn't pull
// in @types/node — so read it through this typed guard instead of referencing the
// `process` global directly. Returns undefined wherever the var (or process) is
// absent, letting callers fall back to a default.
declare const process: { env?: Record<string, string | undefined> } | undefined;

export const env = (key: string): string | undefined =>
  typeof process !== "undefined" ? process?.env?.[key] : undefined;
