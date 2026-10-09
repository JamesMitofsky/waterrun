import { describe, expect, it } from "vitest";
import {
  countBy,
  fountainDotStyle,
  isDogWater,
  isOutOfService,
  rankFountains,
  svcOf,
  toggled,
  waterOf,
} from "../src/fountainFilters";
import type { Fountain } from "@water-run/core/schemas";

const f = (id: number, lat: number, lon: number, tags: Record<string, string> = {}): Fountain => ({
  id,
  lat,
  lon,
  tags,
});

describe("classification", () => {
  it("flags dog water", () => {
    expect(isDogWater({ drinking_water: "no" })).toBe(true);
    expect(isDogWater({ drinking_water: "yes" })).toBe(false);
    expect(isDogWater({})).toBe(false);
    expect(waterOf({ drinking_water: "no" })).toBe("dog");
    expect(waterOf({})).toBe("human");
  });

  it("flags out-of-service via lifecycle tags", () => {
    expect(isOutOfService({ "disused:amenity": "drinking_water" })).toBe(true);
    expect(isOutOfService({ "abandoned:amenity": "drinking_water" })).toBe(true);
    expect(isOutOfService({ disused: "yes" })).toBe(true);
    expect(isOutOfService({ amenity: "drinking_water" })).toBe(false);
    expect(svcOf({ disused: "yes" })).toBe("out");
    expect(svcOf({})).toBe("in");
  });
});

describe("rankFountains", () => {
  it("sorts nearest-first from the anchor", () => {
    const anchor = { lat: 0, lon: 0 };
    const ranked = rankFountains([f(1, 1, 1), f(2, 0.1, 0.1), f(3, 0.5, 0.5)], anchor);
    expect(ranked.map((r) => r.f.id)).toEqual([2, 3, 1]);
    expect(ranked[0].distM).toBeGreaterThan(0);
  });

  it("leaves distances null without an anchor", () => {
    const ranked = rankFountains([f(1, 1, 1)], null);
    expect(ranked[0].distM).toBeNull();
  });
});

describe("countBy", () => {
  it("tallies each dimension independently", () => {
    const ranked = rankFountains(
      [
        f(1, 0, 0, { check_date: "2026-02-01" }),
        f(2, 0, 0, { drinking_water: "no" }),
        f(3, 0, 0, { disused: "yes", check_date: "2019-01-01" }),
      ],
      null,
    );
    expect(countBy(ranked)).toEqual({
      humanN: 2,
      dogN: 1,
    });
  });
});

describe("fountainDotStyle", () => {
  const NOW = new Date("2026-07-10T00:00:00Z").getTime();

  it("green + opaque when surveyed within the last year", () => {
    expect(fountainDotStyle({ check_date: "2026-02-01" }, NOW)).toEqual({
      color: "#16a34a",
      opacity: 1,
    });
  });

  it("orange for 1–3 years ago", () => {
    expect(fountainDotStyle({ check_date: "2024-06-01" }, NOW)).toEqual({
      color: "#f97316",
      opacity: 1,
    });
  });

  it("red for over 3 years ago", () => {
    expect(fountainDotStyle({ check_date: "2020-01-01" }, NOW)).toEqual({
      color: "#ef4444",
      opacity: 1,
    });
  });

  it("red for never surveyed", () => {
    expect(fountainDotStyle({}, NOW)).toEqual({ color: "#ef4444", opacity: 1 });
  });

  it("translucent gray for recently-confirmed out-of-service", () => {
    expect(
      fountainDotStyle({ check_date: "2026-02-01", "disused:amenity": "drinking_water" }, NOW),
    ).toEqual({ color: "#9ca3af", opacity: 0.7 });
  });

  it("draws abandoned the same as disused", () => {
    for (const check_date of ["2026-02-01", "2024-06-01", "2020-01-01"]) {
      expect(fountainDotStyle({ check_date, "abandoned:amenity": "drinking_water" }, NOW)).toEqual(
        fountainDotStyle({ check_date, "disused:amenity": "drinking_water" }, NOW),
      );
    }
  });

  it("keeps red for out-of-service last surveyed over 3 years ago", () => {
    expect(fountainDotStyle({ check_date: "2020-01-01", disused: "yes" }, NOW)).toEqual({
      color: "#ef4444",
      opacity: 1,
    });
  });
});

describe("toggled", () => {
  it("adds and removes without mutating", () => {
    const base = new Set(["a"]);
    expect(toggled(base, "b")).toEqual(new Set(["a", "b"]));
    expect(toggled(base, "a")).toEqual(new Set());
    expect(base).toEqual(new Set(["a"]));
  });
});
