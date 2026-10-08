import { describe, expect, it } from "vitest";
import {
  CHECK_DATE_KEYS,
  checkedAgoLabel,
  lastCheckedMs,
  matchesRecency,
  parseCheckDate,
} from "../src/checkDate";

describe("parseCheckDate", () => {
  it("parses a full YYYY-MM-DD date", () => {
    expect(parseCheckDate("2024-03-15")).toBe(Date.UTC(2024, 2, 15));
  });

  it("resolves partial dates to their earliest instant", () => {
    expect(parseCheckDate("2024")).toBe(Date.UTC(2024, 0, 1));
    expect(parseCheckDate("2024-03")).toBe(Date.UTC(2024, 2, 1));
  });

  it("tolerates surrounding whitespace and trailing text", () => {
    expect(parseCheckDate(" 2024-03-15 ")).toBe(Date.UTC(2024, 2, 15));
    expect(parseCheckDate("2024-03-15;fixme")).toBe(Date.UTC(2024, 2, 15));
  });

  it("returns null for missing or unparseable values", () => {
    expect(parseCheckDate(undefined)).toBeNull();
    expect(parseCheckDate("")).toBeNull();
    expect(parseCheckDate("yes")).toBeNull();
    expect(parseCheckDate("15/03/2024")).toBeNull();
  });

  it("rejects out-of-range months and days instead of rolling them over", () => {
    expect(parseCheckDate("2024-13-45")).toBeNull();
    expect(parseCheckDate("2024-00")).toBeNull();
    expect(parseCheckDate("2024-04-31")).toBeNull();
    expect(parseCheckDate("2023-02-29")).toBeNull();
    expect(parseCheckDate("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    expect(parseCheckDate("2024-12-31")).toBe(Date.UTC(2024, 11, 31));
  });
});

describe("lastCheckedMs", () => {
  it("returns null when no survey tag is present", () => {
    expect(lastCheckedMs({})).toBeNull();
    expect(lastCheckedMs({ amenity: "drinking_water" })).toBeNull();
  });

  it("reads each supported survey key", () => {
    for (const key of CHECK_DATE_KEYS) {
      expect(lastCheckedMs({ [key]: "2023-06-01" })).toBe(Date.UTC(2023, 5, 1));
    }
  });

  it("takes the most recent date across the keys", () => {
    expect(lastCheckedMs({ "survey:date": "2020-01-01", check_date: "2024-01-01" })).toBe(
      Date.UTC(2024, 0, 1),
    );
    // An older check_date must not hide a newer survey:date.
    expect(lastCheckedMs({ check_date: "2019-01-01", "survey:date": "2025-05-01" })).toBe(
      Date.UTC(2025, 4, 1),
    );
    expect(lastCheckedMs({ check_date: "2021", checked: "2023-07" })).toBe(Date.UTC(2023, 6, 1));
  });

  it("skips a garbage value and uses the next valid key", () => {
    expect(lastCheckedMs({ check_date: "June 2024", "survey:date": "2024-05-01" })).toBe(
      Date.UTC(2024, 4, 1),
    );
    expect(lastCheckedMs({ check_date: "2024-13-45", checked: "2022-01-01" })).toBe(
      Date.UTC(2022, 0, 1),
    );
  });

  it("returns null when the tag value is garbage", () => {
    expect(lastCheckedMs({ check_date: "unknown" })).toBeNull();
    expect(lastCheckedMs({ check_date: "2024-13-45" })).toBeNull();
  });
});

describe("matchesRecency", () => {
  const cutoff = Date.UTC(2026, 0, 1);

  it('"any" keeps everything', () => {
    expect(matchesRecency({}, "any", cutoff)).toBe(true);
    expect(matchesRecency({ check_date: "1990-01-01" }, "any", cutoff)).toBe(true);
  });

  it('"stale" keeps never-surveyed points', () => {
    expect(matchesRecency({}, "stale", cutoff)).toBe(true);
  });

  it('"stale" keeps points surveyed before the cutoff, drops recent ones', () => {
    expect(matchesRecency({ check_date: "2025-12-31" }, "stale", cutoff)).toBe(true);
    expect(matchesRecency({ check_date: "2026-01-01" }, "stale", cutoff)).toBe(false);
    expect(matchesRecency({ check_date: "2026-06-15" }, "stale", cutoff)).toBe(false);
  });

  it('"fresh" keeps only points surveyed on/after the cutoff', () => {
    expect(matchesRecency({}, "fresh", cutoff)).toBe(false);
    expect(matchesRecency({ check_date: "2025-12-31" }, "fresh", cutoff)).toBe(false);
    expect(matchesRecency({ check_date: "2026-01-01" }, "fresh", cutoff)).toBe(true);
  });
});

describe("checkedAgoLabel", () => {
  const now = Date.UTC(2026, 8, 10);
  const daysAgo = (n: number) => ({ check_date: new Date(now - n * 86_400_000).toISOString() });

  it("says so when a point has never been checked", () => {
    expect(checkedAgoLabel({}, now)).toBe("Never checked");
    expect(checkedAgoLabel({ name: "x" }, now, "long")).toBe("Never checked");
  });

  it("is 'today' inside the first day", () => {
    expect(checkedAgoLabel(daysAgo(0), now)).toBe("Checked today");
    expect(checkedAgoLabel(daysAgo(0), now, "long")).toBe("Checked today");
  });

  it("counts days, then weeks, months and years, in the short style", () => {
    expect(checkedAgoLabel(daysAgo(1), now)).toBe("Checked 1d ago");
    expect(checkedAgoLabel(daysAgo(6), now)).toBe("Checked 6d ago");
    expect(checkedAgoLabel(daysAgo(7), now)).toBe("Checked 1w ago");
    expect(checkedAgoLabel(daysAgo(29), now)).toBe("Checked 4w ago");
    expect(checkedAgoLabel(daysAgo(30), now)).toBe("Checked 1mo ago");
    expect(checkedAgoLabel(daysAgo(155), now)).toBe("Checked 5mo ago");
    expect(checkedAgoLabel(daysAgo(364), now)).toBe("Checked 12mo ago");
    expect(checkedAgoLabel(daysAgo(365), now)).toBe("Checked 1y ago");
  });

  it("spells the units out, singular and plural, in the long style", () => {
    expect(checkedAgoLabel(daysAgo(1), now, "long")).toBe("Checked 1 day ago");
    expect(checkedAgoLabel(daysAgo(3), now, "long")).toBe("Checked 3 days ago");
    expect(checkedAgoLabel(daysAgo(7), now, "long")).toBe("Checked 1 week ago");
    expect(checkedAgoLabel(daysAgo(21), now, "long")).toBe("Checked 3 weeks ago");
    expect(checkedAgoLabel(daysAgo(155), now, "long")).toBe("Checked 5 months ago");
    expect(checkedAgoLabel(daysAgo(800), now, "long")).toBe("Checked 2 years ago");
  });

  it("never counts a future date as negative", () => {
    expect(checkedAgoLabel(daysAgo(-3), now)).toBe("Checked today");
  });
});
