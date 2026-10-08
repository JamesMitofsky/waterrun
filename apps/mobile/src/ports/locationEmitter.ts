import type { GeoPoint } from "@water-run/core/ports";

// A tiny module-scope emitter that bridges the background TaskManager location task
// (which runs outside React) to the run hook's subscribers. The task pushes points
// here; trackRun (tasks/runLocationTask) subscribes.
const listeners = new Set<(p: GeoPoint) => void>();

export function emitPoint(p: GeoPoint): void {
  listeners.forEach((l) => l(p));
}

export function onPoint(fn: (p: GeoPoint) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function listenerCount(): number {
  return listeners.size;
}
