import type { RunActivityState } from "@water-run/core/ports";

// Live Activity / Dynamic Island is a v1.1 feature (expo-widgets); these are no-ops
// for now, kept so the run hook stays platform-neutral. The RunActivityState shape
// is what the widget will consume.
export async function startRunActivity(_s: RunActivityState): Promise<void> {}

export async function updateRunActivity(_s: RunActivityState): Promise<void> {}

export async function endRunActivity(): Promise<void> {}
