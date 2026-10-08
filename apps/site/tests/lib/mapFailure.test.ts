import { describe, expect, it } from "vitest";
import { isFatalMapError } from "@/lib/mapFailure";

// The shapes MapLibre's `error` event arrives in. A source's events reach the
// map with `sourceId` (and more) merged in by the style; a failed tile also
// carries the tile.
const error = new Error("boom");

describe("isFatalMapError", () => {
  it("is fatal for a source that failed outright (its TileJSON)", () => {
    expect(isFatalMapError({ error, sourceId: "carto", isSourceLoaded: true })).toBe(true);
  });

  it("is not fatal for a single tile that failed", () => {
    expect(isFatalMapError({ error, sourceId: "carto", tile: {} })).toBe(false);
  });

  it("is not fatal for a failure outside any source (a sprite, a glyph)", () => {
    expect(isFatalMapError({ error })).toBe(false);
  });
});
