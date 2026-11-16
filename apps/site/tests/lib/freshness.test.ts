import { describe, expect, it } from "vitest";
import { bucketOf } from "@/lib/freshness";

const NOW = Date.parse("2026-11-16T00:00:00Z");
const RECENT = { check_date: "2026-06-01" };
const TWO_YEARS = { check_date: "2024-06-01" };
const FIVE_YEARS = { check_date: "2021-06-01" };
const OUT = { "disused:amenity": "drinking_water" };

describe("bucketOf", () => {
  it("is fresh for a working point checked within a year", () => {
    expect(bucketOf(RECENT, NOW)).toBe("fresh");
  });

  it("is out of service for a point found not working within a year", () => {
    expect(bucketOf({ ...OUT, ...RECENT }, NOW)).toBe("out_of_service");
  });

  it("is stale past a year, however long ago", () => {
    expect(bucketOf(TWO_YEARS, NOW)).toBe("stale");
    expect(bucketOf(FIVE_YEARS, NOW)).toBe("stale");
  });

  it("is stale when never checked", () => {
    expect(bucketOf({}, NOW)).toBe("stale");
  });

  it("is stale for an out-of-service point checked over a year ago, or never", () => {
    expect(bucketOf({ ...OUT, ...TWO_YEARS }, NOW)).toBe("stale");
    expect(bucketOf(OUT, NOW)).toBe("stale");
  });
});
