import { describe, expect, it } from "vitest";
import { bucketOf, isRetired } from "@/lib/freshness";

const NOW = Date.parse("2026-11-16T00:00:00Z");
const RECENT = { check_date: "2026-06-01" };
const TWO_YEARS = { check_date: "2024-06-01" };
const FIVE_YEARS = { check_date: "2021-06-01" };
const OUT = { "disused:amenity": "drinking_water" };

describe("bucketOf", () => {
  it("is fresh within a year of the last check", () => {
    expect(bucketOf(RECENT, NOW)).toBe("fresh");
  });

  it("is stale past a year, however long ago", () => {
    expect(bucketOf(TWO_YEARS, NOW)).toBe("stale");
    expect(bucketOf(FIVE_YEARS, NOW)).toBe("stale");
  });

  it("is stale when never checked", () => {
    expect(bucketOf({}, NOW)).toBe("stale");
  });
});

describe("isRetired", () => {
  it("is true for out-of-service points checked within a year", () => {
    expect(isRetired({ ...OUT, ...RECENT }, NOW)).toBe(true);
  });

  it("is false for out-of-service points checked longer ago, or never", () => {
    expect(isRetired({ ...OUT, ...TWO_YEARS }, NOW)).toBe(false);
    expect(isRetired(OUT, NOW)).toBe(false);
  });

  it("is false for in-service points", () => {
    expect(isRetired(RECENT, NOW)).toBe(false);
  });
});
