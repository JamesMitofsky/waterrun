import { describe, expect, it } from "vitest";
import {
  arrivalMs,
  easeInOut,
  easedSegments,
  legSchedule,
  lengthAt,
  timeAt,
  type EasedSegment,
} from "@/lib/runReplay";

describe("easeInOut", () => {
  it("is at rest at both ends and halfway in the middle", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBe(0.5);
    expect(easeInOut(1)).toBe(1);
  });

  it("clamps outside 0–1", () => {
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(2)).toBe(1);
  });

  it("is slower near the ends than in the middle", () => {
    const early = easeInOut(0.1) - easeInOut(0);
    const mid = easeInOut(0.55) - easeInOut(0.45);
    const late = easeInOut(1) - easeInOut(0.9);
    expect(early).toBeLessThan(mid);
    expect(late).toBeLessThan(mid);
  });
});

describe("legSchedule", () => {
  it("gives each leg time in proportion to its length", () => {
    const legs = legSchedule([0, 10, 40], 1000);
    expect(legs).toEqual([
      { fromMs: 0, toMs: 250, fromLen: 0, toLen: 10 },
      { fromMs: 250, toMs: 1000, fromLen: 10, toLen: 40 },
    ]);
  });

  it("sorts and de-duplicates the checkpoints", () => {
    const legs = legSchedule([40, 0, 10, 10], 1000);
    expect(legs.map((l) => [l.fromLen, l.toLen])).toEqual([
      [0, 10],
      [10, 40],
    ]);
  });

  it("ends exactly on the total", () => {
    const legs = legSchedule([0, 1 / 3, 2 / 3, 1], 1000);
    expect(legs[legs.length - 1].toMs).toBe(1000);
  });

  it("has no legs without two distinct checkpoints", () => {
    expect(legSchedule([], 1000)).toEqual([]);
    expect(legSchedule([5], 1000)).toEqual([]);
    expect(legSchedule([5, 5], 1000)).toEqual([]);
  });
});

describe("lengthAt", () => {
  const legs = legSchedule([0, 10, 40], 1000);

  it("is at the start before the replay and at the end after it", () => {
    expect(lengthAt(legs, -5)).toBe(0);
    expect(lengthAt(legs, 0)).toBe(0);
    expect(lengthAt(legs, 1000)).toBe(40);
    expect(lengthAt(legs, 5000)).toBe(40);
  });

  it("comes to rest at every checkpoint", () => {
    expect(lengthAt(legs, 250)).toBe(10);
    const justBefore = lengthAt(legs, 249);
    const justAfter = lengthAt(legs, 251);
    // Barely moving on either side of the stop.
    expect(10 - justBefore).toBeLessThan(0.01);
    expect(justAfter - 10).toBeLessThan(0.01);
  });

  it("is halfway along a leg halfway through its time", () => {
    expect(lengthAt(legs, 125)).toBe(5);
    expect(lengthAt(legs, 625)).toBe(25);
  });

  it("never runs backwards", () => {
    let prev = -1;
    for (let ms = 0; ms <= 1000; ms += 7) {
      const len = lengthAt(legs, ms);
      expect(len).toBeGreaterThanOrEqual(prev);
      prev = len;
    }
  });

  it("is zero with no legs", () => {
    expect(lengthAt([], 100)).toBe(0);
  });
});

describe("arrivalMs", () => {
  const legs = legSchedule([0, 10, 40], 1000);

  it("is the start for the first checkpoint", () => {
    expect(arrivalMs(legs, 0)).toBe(0);
  });

  it("is the end of the leg for every other checkpoint", () => {
    expect(arrivalMs(legs, 10)).toBe(250);
    expect(arrivalMs(legs, 40)).toBe(1000);
  });

  it("is undefined off a checkpoint or with no legs", () => {
    expect(arrivalMs(legs, 20)).toBeUndefined();
    expect(arrivalMs([], 0)).toBeUndefined();
  });
});

describe("timeAt", () => {
  const legs = legSchedule([0, 10, 40], 1000);

  it("undoes lengthAt", () => {
    for (let ms = 0; ms <= 1000; ms += 13) {
      expect(timeAt(legs, lengthAt(legs, ms))).toBeCloseTo(ms, 4);
    }
  });

  it("is a checkpoint's arrival at that checkpoint", () => {
    expect(timeAt(legs, 10)).toBe(250);
    expect(timeAt(legs, 25)).toBeCloseTo(625, 9);
  });

  it("clamps to the schedule's ends", () => {
    expect(timeAt(legs, -1)).toBe(0);
    expect(timeAt(legs, 99)).toBe(1000);
    expect(timeAt([], 5)).toBe(0);
  });
});

describe("easedSegments", () => {
  const legs = legSchedule([0, 10, 40], 1000);
  // y at s along a `cubic-bezier` whose x control points are 1/3 and 2/3, so
  // x(t) = t and s is the curve's own parameter.
  const bezierY = ([, y1, , y2]: EasedSegment["bezier"], s: number) =>
    3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3;

  it("tiles the schedule end to end, in time and in length", () => {
    const segments = easedSegments(legs, [2, 30]);
    expect(segments[0].fromMs).toBe(0);
    expect(segments[0].fromLen).toBe(0);
    expect(segments[segments.length - 1].toMs).toBe(1000);
    expect(segments[segments.length - 1].toLen).toBe(40);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].fromMs).toBeCloseTo(segments[i - 1].toMs, 9);
      expect(segments[i].fromLen).toBeCloseTo(segments[i - 1].toLen, 9);
    }
  });

  it("cuts every leg at its midpoint and at each break inside it", () => {
    const cutsAt = easedSegments(legs, [2, 10, 30, 50]).map((s) => s.fromMs);
    expect(cutsAt).toHaveLength(6);
    expect(cutsAt).toContain(125);
    expect(cutsAt).toContain(625);
    expect(cutsAt.some((ms) => Math.abs(ms - timeAt(legs, 2)) < 1e-9)).toBe(true);
    expect(cutsAt.some((ms) => Math.abs(ms - timeAt(legs, 30)) < 1e-9)).toBe(true);
  });

  it("does not cut twice where a break lands on a midpoint", () => {
    expect(easedSegments(legs, [5])).toHaveLength(4);
  });

  it("keeps x linear, so each curve is a function of time alone", () => {
    for (const { bezier } of easedSegments(legs, [2, 30])) {
      expect(bezier[0]).toBe(1 / 3);
      expect(bezier[2]).toBe(2 / 3);
    }
  });

  it("moves exactly as lengthAt does, not only at its ends", () => {
    for (const seg of easedSegments(legs, [2, 7, 30])) {
      for (let s = 0; s <= 1; s += 0.05) {
        const ms = seg.fromMs + s * (seg.toMs - seg.fromMs);
        const played = seg.fromLen + (seg.toLen - seg.fromLen) * bezierY(seg.bezier, s);
        expect(Math.abs(played - lengthAt(legs, ms))).toBeLessThan(1e-9);
      }
    }
  });
});
