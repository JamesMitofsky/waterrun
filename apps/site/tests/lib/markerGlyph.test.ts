import { describe, expect, it } from "vitest";
import {
  MARKER_GLYPH_BOX_PX,
  markerGlyphImage,
  markerGlyphImageId,
  markerGlyphOfImageId,
} from "@/lib/markerGlyph";

// MapLibre's SDF edge, 192/256 of the alpha range. Inside the shape is above
// it, outside below.
const EDGE = 0.75 * 255;
const BOX = MARKER_GLYPH_BOX_PX;

function alphaReader(glyph: "x" | "question") {
  const image = markerGlyphImage(glyph);
  return (x: number, y: number) => image.data[(y * image.width + x) * 4 + 3]!;
}

describe("marker glyph image ids", () => {
  it("round-trips a glyph through its image id", () => {
    expect(markerGlyphOfImageId(markerGlyphImageId("x"))).toBe("x");
    expect(markerGlyphOfImageId(markerGlyphImageId("question"))).toBe("question");
  });

  it("does not claim other images", () => {
    expect(markerGlyphOfImageId("place-dot")).toBeNull();
    expect(markerGlyphOfImageId("marker-glyph-nope")).toBeNull();
  });
});

describe("markerGlyphImage", () => {
  it("is a square box of RGBA pixels", () => {
    const image = markerGlyphImage("x");
    expect(image.width).toBe(BOX);
    expect(image.height).toBe(BOX);
    expect(image.data.length).toBe(BOX * BOX * 4);
  });

  it("draws the X through the centre and along both diagonals, clear of the corners", () => {
    const alpha = alphaReader("x");
    const mid = BOX / 2;
    expect(alpha(mid, mid)).toBeGreaterThan(EDGE);
    // A quarter of the way in from each corner, on the diagonals.
    for (const [x, y] of [
      [11, 11],
      [20, 11],
      [11, 20],
      [20, 20],
    ] as const) {
      expect(alpha(x, y)).toBeGreaterThan(EDGE);
    }
    // Between the arms, and out at the box's corners.
    expect(alpha(mid, 4)).toBeLessThan(EDGE);
    expect(alpha(4, mid)).toBeLessThan(EDGE);
    expect(alpha(0, 0)).toBeLessThan(EDGE);
    expect(alpha(BOX - 1, BOX - 1)).toBeLessThan(EDGE);
  });

  it("draws the question mark's hook, stem and dot, with a gap above the dot", () => {
    const alpha = alphaReader("question");
    const mid = BOX / 2;
    // Top of the hook, the stem, the dot: all on the centre line.
    expect(alpha(mid, 7)).toBeGreaterThan(EDGE);
    expect(alpha(mid, 18)).toBeGreaterThan(EDGE);
    expect(alpha(mid, 24)).toBeGreaterThan(EDGE);
    // The gap between stem and dot, and the hollow inside the hook.
    expect(alpha(mid, 21)).toBeLessThan(EDGE);
    expect(alpha(mid, 12)).toBeLessThan(EDGE);
    expect(alpha(0, 0)).toBeLessThan(EDGE);
  });
});
