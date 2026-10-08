// The run's progress line for the lock screen ("0.3 mi to Main St fountain •
// Next: Left in 250 ft"), shown as a notification until a real Live Activity
// exists. The guidance behind it changes with every GPS fix, about every 2 s at
// a run, but a notification is an alert surface: each post is a native round
// trip and, wherever the system treats it as new, another alert. So distances
// are rounded to steps a runner can act on, and a post goes out only when the
// line says something new, at most once per PROGRESS_MIN_INTERVAL_MS. A new
// target or a new next turn is what the runner needs to know, so it goes out
// sooner, held back only by PROGRESS_MIN_CHANGE_MS.
import { metersToFeet, metersToMiles, turnSide } from "./geo";
import type { Turn } from "./brouter";

export const PROGRESS_MIN_INTERVAL_MS = 30_000;
// GPS jitter at a corner can flip the next turn back and forth on successive
// fixes; this keeps that from turning into a post per fix.
export const PROGRESS_MIN_CHANGE_MS = 5_000;

export type ProgressLine = {
  stop: string; // which stop the runner is heading for
  turn: string | null; // which maneuver comes next (the turn itself, not how far off)
  body: string;
};

export type PostedProgress = ProgressLine & { atMs: number };

// A distance in steps that read at a glance: 50 ft up to 1000 ft, then tenths
// of a mile. Never "0 ft": a runner that close has arrived anyway.
export function fmtProgressDist(m: number): string {
  const ft = Math.round(metersToFeet(m) / 50) * 50;
  if (ft < 1000) return `${Math.max(ft, 50)} ft`;
  return `${metersToMiles(m).toFixed(1)} mi`;
}

export function progressLine(o: {
  stopKey: string;
  stopName: string;
  distToStopM: number;
  nextTurn: Turn | null;
  distToTurnM: number | null;
}): ProgressLine {
  const toStop = `${fmtProgressDist(o.distToStopM)} to ${o.stopName}`;
  if (!o.nextTurn || o.distToTurnM == null) return { stop: o.stopKey, turn: null, body: toStop };
  const side = turnSide(o.nextTurn.angle);
  const turn = `${side[0].toUpperCase()}${side.slice(1)} in ${fmtProgressDist(o.distToTurnM)}`;
  return {
    stop: o.stopKey,
    // A turn's distance along the route is unique to it.
    turn: String(o.nextTurn.distM),
    body: `${toStop} • Next: ${turn}`,
  };
}

// Whether `next` is worth a post, given what was posted last (null: nothing is
// showing).
export function shouldPostProgress(
  prev: PostedProgress | null,
  next: ProgressLine,
  nowMs: number,
): boolean {
  if (!prev) return true;
  const sinceMs = nowMs - prev.atMs;
  if (next.stop !== prev.stop || next.turn !== prev.turn) return sinceMs >= PROGRESS_MIN_CHANGE_MS;
  if (next.body === prev.body) return false;
  return sinceMs >= PROGRESS_MIN_INTERVAL_MS;
}
