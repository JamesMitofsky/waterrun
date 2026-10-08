import { describe, expect, it } from "vitest";
import {
  fmtProgressDist,
  progressLine,
  shouldPostProgress,
  PROGRESS_MIN_CHANGE_MS,
  PROGRESS_MIN_INTERVAL_MS,
  type PostedProgress,
  type ProgressLine,
} from "../src/runProgress";
import type { Turn } from "../src/brouter";

const FT = 0.3048;
const MI = 1609.344;

const turn = (distM: number, angle: number): Turn => ({ lat: 0, lon: 0, distM, angle });

describe("fmtProgressDist", () => {
  it("rounds to 50 ft steps under 1000 ft", () => {
    expect(fmtProgressDist(330 * FT)).toBe("350 ft");
    expect(fmtProgressDist(310 * FT)).toBe("300 ft");
    expect(fmtProgressDist(960 * FT)).toBe("950 ft");
  });

  it("never says 0 ft", () => {
    expect(fmtProgressDist(0)).toBe("50 ft");
    expect(fmtProgressDist(10 * FT)).toBe("50 ft");
  });

  it("switches to tenths of a mile once the step reaches 1000 ft", () => {
    expect(fmtProgressDist(990 * FT)).toBe("0.2 mi");
    expect(fmtProgressDist(1.44 * MI)).toBe("1.4 mi");
  });

  it("holds still while a runner covers a few meters", () => {
    expect(fmtProgressDist(300)).toBe(fmtProgressDist(304));
  });
});

describe("progressLine", () => {
  const base = { stopKey: "0:7", stopName: "Main St fountain", distToStopM: 500 };

  it("names the next stop and how far it is", () => {
    expect(progressLine({ ...base, nextTurn: null, distToTurnM: null })).toEqual({
      stop: "0:7",
      turn: null,
      body: "0.3 mi to Main St fountain",
    });
  });

  it("adds the side of the next turn, left for a negative angle", () => {
    const left = progressLine({ ...base, nextTurn: turn(120, -90), distToTurnM: 76 });
    expect(left.body).toBe("0.3 mi to Main St fountain • Next: Left in 250 ft");
    const right = progressLine({ ...base, nextTurn: turn(120, 60), distToTurnM: 76 });
    expect(right.body).toBe("0.3 mi to Main St fountain • Next: Right in 250 ft");
  });

  it("identifies the turn by where it is, not by how far off it is", () => {
    const a = progressLine({ ...base, nextTurn: turn(120, -90), distToTurnM: 76 });
    const b = progressLine({ ...base, nextTurn: turn(120, -90), distToTurnM: 20 });
    expect(a.turn).toBe(b.turn);
    expect(progressLine({ ...base, nextTurn: turn(300, -90), distToTurnM: 76 }).turn).not.toBe(
      a.turn,
    );
  });
});

describe("shouldPostProgress", () => {
  const line = (over: Partial<ProgressLine> = {}): ProgressLine => ({
    stop: "0:7",
    turn: "120",
    body: "0.3 mi to A • Next: Left in 250 ft",
    ...over,
  });
  const posted = (atMs: number, over: Partial<ProgressLine> = {}): PostedProgress => ({
    ...line(over),
    atMs,
  });

  it("posts when nothing is showing", () => {
    expect(shouldPostProgress(null, line(), 0)).toBe(true);
  });

  it("never reposts the same text", () => {
    expect(shouldPostProgress(posted(0), line(), 10 * PROGRESS_MIN_INTERVAL_MS)).toBe(false);
  });

  it("holds new distances back until the interval has passed", () => {
    const next = line({ body: "0.2 mi to A • Next: Left in 100 ft" });
    expect(shouldPostProgress(posted(0), next, PROGRESS_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldPostProgress(posted(0), next, PROGRESS_MIN_INTERVAL_MS)).toBe(true);
  });

  it("posts a new target or a new turn soon, but not on every flip", () => {
    const newStop = line({ stop: "1:8", body: "0.5 mi to B" });
    const newTurn = line({ turn: "300", body: "0.3 mi to A • Next: Right in 600 ft" });
    for (const next of [newStop, newTurn]) {
      expect(shouldPostProgress(posted(0), next, PROGRESS_MIN_CHANGE_MS - 1)).toBe(false);
      expect(shouldPostProgress(posted(0), next, PROGRESS_MIN_CHANGE_MS)).toBe(true);
    }
  });

  it("posts the turn going away as a change", () => {
    const noTurn = line({ turn: null, body: "0.3 mi to A" });
    expect(shouldPostProgress(posted(0), noTurn, PROGRESS_MIN_CHANGE_MS)).toBe(true);
  });
});
