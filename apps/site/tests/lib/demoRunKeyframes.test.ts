import { describe, expect, it } from "vitest";
import { MAP_FRAMES } from "@/lib/basemap/frames";
import { DEMO_LEGS, DEMO_RUN_END, DEMO_RUN_TIMING, demoRunnerAt } from "@/lib/demoRun";
import {
  demoRunKeyframes,
  demoRunTrack,
  framePoint,
  type RunKeyframe,
} from "@/lib/demoRunKeyframes";
import { lengthAt } from "@/lib/runReplay";

const { runMs } = DEMO_RUN_TIMING;

/** y at s along a keyframe's `cubic-bezier(1/3, y1, 2/3, y2)`. */
function easingAt(easing: string, s: number) {
  const [, y1, , y2] = easing.slice("cubic-bezier(".length, -1).split(",").map(Number);
  return 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3;
}

/** What a browser shows `ms` into the run, interpolating the keyframes as CSS does. */
function played(keyframes: RunKeyframe[], ms: number) {
  const pct = (ms / runMs) * 100;
  const next = keyframes.findIndex((k) => k.pct > pct);
  if (next === -1) return keyframes[keyframes.length - 1];
  if (next === 0) return keyframes[0];
  const a = keyframes[next - 1];
  const b = keyframes[next];
  const y = easingAt(a.easing!, (pct - a.pct) / (b.pct - a.pct));
  return {
    x: a.x + (b.x - a.x) * y,
    y: a.y + (b.y - a.y) * y,
    dash: a.dash + (b.dash - a.dash) * y,
  };
}

describe.each(MAP_FRAMES["demo-run"].variants)("the run's keyframes ($media)", (variant) => {
  const keyframes = demoRunKeyframes(variant);
  const track = demoRunTrack(variant);

  it("run from 0% to 100%, ascending, with a timing function to every next one", () => {
    expect(keyframes[0].pct).toBe(0);
    expect(keyframes[keyframes.length - 1].pct).toBe(100);
    for (let i = 1; i < keyframes.length; i++) {
      expect(keyframes[i].pct).toBeGreaterThan(keyframes[i - 1].pct);
      expect(keyframes[i - 1].easing).toMatch(/^cubic-bezier\(/);
    }
    expect(keyframes[keyframes.length - 1].easing).toBeUndefined();
  });

  it("open with nothing run and close with the run drawn to the next stop", () => {
    const first = keyframes[0];
    const last = keyframes[keyframes.length - 1];
    expect(first.dash).toBeCloseTo(track.length, 1);
    expect(last.dash).toBe(0);
    expect([first.x, first.y]).toEqual([track.points[0].x, track.points[0].y]);
    const tip = track.points[track.points.length - 1];
    expect([last.x, last.y]).toEqual([tip.x, tip.y]);
  });

  it("put the runner and the line's tip where the replay has them, at every frame", () => {
    for (let ms = 0; ms <= runMs; ms += 1000 / 60) {
      const want = track.at(lengthAt(DEMO_LEGS, ms));
      const got = played(keyframes, ms);
      expect(Math.abs(got.x - want.x)).toBeLessThan(0.05);
      expect(Math.abs(got.y - want.y)).toBeLessThan(0.05);
      expect(Math.abs(got.dash - (track.length - want.along))).toBeLessThan(0.05);
    }
  });

  it("draw the runner within a fraction of a pixel of where the live map puts it", () => {
    for (let i = 0; i <= 200; i++) {
      const length = (DEMO_RUN_END * i) / 200;
      const [lat, lon] = demoRunnerAt(length);
      const live = framePoint(variant, { lat, lon });
      const drawn = track.at(length);
      expect(Math.hypot(drawn.x - live.x, drawn.y - live.y)).toBeLessThan(0.25);
    }
  });
});
