import { describe, expect, it } from "vitest";
import { pointStateOf, pointStatusLine } from "../src/pointStatus";

describe("pointStateOf", () => {
  it("is working while the primary tag is live", () => {
    expect(pointStateOf({ amenity: "drinking_water" })).toBe("working");
    expect(pointStateOf({})).toBe("working");
  });

  it("is out of order under the disused: prefix", () => {
    expect(pointStateOf({ "disused:amenity": "drinking_water" })).toBe("out_of_order");
  });

  it("honors a standalone disused=yes, as the map dot does", () => {
    expect(pointStateOf({ amenity: "drinking_water", disused: "yes" })).toBe("out_of_order");
  });

  it("is removed under the abandoned: prefix", () => {
    expect(pointStateOf({ "abandoned:amenity": "drinking_water" })).toBe("removed");
  });

  it("lets abandoned win over disused", () => {
    expect(
      pointStateOf({ "abandoned:amenity": "drinking_water", "disused:amenity": "drinking_water" }),
    ).toBe("removed");
    expect(pointStateOf({ "abandoned:amenity": "drinking_water", disused: "yes" })).toBe("removed");
  });
});

describe("pointStatusLine", () => {
  const now = Date.UTC(2026, 8, 10);
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();

  it("pairs how long ago the point was checked with its state", () => {
    expect(pointStatusLine({ amenity: "drinking_water", check_date: daysAgo(21) }, now)).toBe(
      "Checked 3 weeks ago · In service",
    );
    expect(
      pointStatusLine({ "disused:amenity": "drinking_water", check_date: daysAgo(0) }, now),
    ).toBe("Checked today · Out of order");
    expect(
      pointStatusLine({ "abandoned:amenity": "drinking_water", check_date: daysAgo(800) }, now),
    ).toBe("Checked 2 years ago · Removed");
  });

  it('doesn\'t call a fountain surveyed as partially working "Working"', () => {
    // What a "partially working" survey leaves on the node: the live primary
    // tag, a fresh check date and the note saying what's wrong.
    const surveyedBroken = {
      amenity: "drinking_water",
      check_date: daysAgo(1),
      note: "Low water pressure",
    };
    expect(pointStatusLine(surveyedBroken, now)).toBe("Checked 1 day ago · In service");
  });

  it("only says what a never-checked point is listed as", () => {
    expect(pointStatusLine({ amenity: "drinking_water" }, now)).toBe(
      "Never checked · Listed as in service",
    );
    expect(pointStatusLine({ "disused:amenity": "drinking_water" }, now)).toBe(
      "Never checked · Listed as out of order",
    );
    expect(pointStatusLine({ "abandoned:amenity": "drinking_water" }, now)).toBe(
      "Never checked · Listed as removed",
    );
    // A check date that doesn't parse is no check at all.
    expect(pointStatusLine({ amenity: "drinking_water", check_date: "unknown" }, now)).toBe(
      "Never checked · Listed as in service",
    );
  });

  it("reads the other survey keys, as lastCheckedMs does", () => {
    expect(pointStatusLine({ amenity: "drinking_water", "survey:date": daysAgo(3) }, now)).toBe(
      "Checked 3 days ago · In service",
    );
    expect(pointStatusLine({ amenity: "drinking_water", checked: daysAgo(155) }, now)).toBe(
      "Checked 5 months ago · In service",
    );
  });
});
