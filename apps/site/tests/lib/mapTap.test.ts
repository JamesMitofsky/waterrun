import { describe, expect, it } from "vitest";
import { nearestTo, tapSlopPx, TAP_REACH_PX, type ScreenPoint } from "@/lib/mapTap";

type Dot = { id: string; at: ScreenPoint };
const at = (d: Dot) => d.at;

describe("tapSlopPx", () => {
  it("grows a tap on a small dot out to the full reach", () => {
    // The live map's dots: radius 6 plus a 2px ring.
    expect(tapSlopPx(8) + 8).toBe(TAP_REACH_PX);
  });

  it("adds nothing for a dot already as big as the target", () => {
    expect(tapSlopPx(TAP_REACH_PX)).toBe(0);
    expect(tapSlopPx(30)).toBe(0);
  });
});

describe("nearestTo", () => {
  const tap = { x: 100, y: 100 };

  it("picks the candidate nearest the tap", () => {
    const dots: Dot[] = [
      { id: "far", at: { x: 118, y: 100 } },
      { id: "near", at: { x: 96, y: 103 } },
      { id: "farther", at: { x: 80, y: 80 } },
    ];
    expect(nearestTo(tap, dots, at)?.id).toBe("near");
  });

  it("gives a tie to the earlier candidate — the one drawn on top", () => {
    const dots: Dot[] = [
      { id: "top", at: { x: 110, y: 100 } },
      { id: "under", at: { x: 90, y: 100 } },
    ];
    expect(nearestTo(tap, dots, at)?.id).toBe("top");
  });

  it("is undefined when nothing was caught", () => {
    expect(nearestTo(tap, [], at)).toBeUndefined();
  });

  it("picks a lone candidate however far it is", () => {
    const dots: Dot[] = [{ id: "only", at: { x: 400, y: -50 } }];
    expect(nearestTo(tap, dots, at)?.id).toBe("only");
  });
});
