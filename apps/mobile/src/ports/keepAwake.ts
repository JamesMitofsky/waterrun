import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

const TAG = "water-run";

export function keepAwake(): void {
  activateKeepAwakeAsync(TAG).catch(() => {});
}

export function allowSleep(): void {
  try {
    deactivateKeepAwake(TAG);
  } catch {
    /* ignore */
  }
}
