import { describe, expect, it } from "vitest";
import {
  MILES_TO_M,
  bearing,
  boundsCenter,
  boundsRadiusM,
  compass,
  fmtDist,
  haversine,
  maneuver,
  metersToMiles,
  milesToMeters,
  nearestCumDistOnPath,
  pathLength,
  pointAtDistOnPath,
  routeHeadingAt,
  stopsAlongPath,
  toDeg,
  toRad,
  turnSide,
  type Pt,
} from "../src/geo";

// 1 degree of latitude (or of longitude at the equator) on the R=6371000 sphere.
const ONE_DEG_M = (6371000 * Math.PI) / 180; // ≈ 111194.93

describe("toRad / toDeg", () => {
  it("converts degrees to radians and back", () => {
    expect(toRad(180)).toBeCloseTo(Math.PI, 12);
    expect(toRad(0)).toBe(0);
    expect(toDeg(Math.PI)).toBeCloseTo(180, 12);
    expect(toDeg(toRad(37.42))).toBeCloseTo(37.42, 10);
  });
});

describe("mile conversions", () => {
  it("uses the exact international mile", () => {
    expect(milesToMeters(1)).toBe(1609.344);
    expect(metersToMiles(1609.344)).toBe(1);
    expect(MILES_TO_M).toBe(1609.344);
  });

  it("round-trips", () => {
    expect(metersToMiles(milesToMeters(3.7))).toBeCloseTo(3.7, 12);
  });
});

describe("haversine", () => {
  it("is zero for identical points", () => {
    expect(haversine({ lat: 48.85, lon: 2.35 }, { lat: 48.85, lon: 2.35 })).toBe(0);
  });

  it("measures one degree of latitude", () => {
    expect(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(ONE_DEG_M, 5);
  });

  it("measures one degree of longitude at the equator", () => {
    expect(haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(ONE_DEG_M, 5);
  });

  it("shrinks longitude distance with latitude", () => {
    const atEquator = haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    const at60 = haversine({ lat: 60, lon: 0 }, { lat: 60, lon: 1 });
    // Great-circle distance along a parallel is only ~cos-scaled; allow meters of slack.
    expect(at60).toBeCloseTo(atEquator * Math.cos(toRad(60)), -1);
  });

  it("matches the known Paris-London distance", () => {
    const paris = { lat: 48.8566, lon: 2.3522 };
    const london = { lat: 51.5074, lon: -0.1278 };
    const d = haversine(paris, london);
    expect(d).toBeGreaterThan(342_000);
    expect(d).toBeLessThan(345_000);
  });

  it("is symmetric", () => {
    const a = { lat: 40.7, lon: -74 };
    const b = { lat: 34.05, lon: -118.24 };
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 8);
  });

  it("handles antipodal points without NaN (Math.min clamp)", () => {
    const d = haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBeCloseTo(Math.PI * 6371000, 0);
  });
});

describe("boundsCenter", () => {
  it("returns the midpoint of a [w, s, e, n] extent", () => {
    expect(boundsCenter([2, 48, 4, 50])).toEqual({ lat: 49, lon: 3 });
  });

  it("handles a bounds spanning the antimeridian sign flip symmetrically", () => {
    expect(boundsCenter([-1, -1, 1, 1])).toEqual({ lat: 0, lon: 0 });
  });
});

describe("boundsRadiusM", () => {
  it("is the center-to-corner great-circle distance", () => {
    const bounds: [number, number, number, number] = [2, 48, 4, 50];
    const center = boundsCenter(bounds);
    expect(boundsRadiusM(bounds)).toBeCloseTo(haversine(center, { lat: 50, lon: 4 }), 6);
  });

  it("grows as the viewport widens (zoom out => larger radius)", () => {
    const narrow = boundsRadiusM([2.9, 48.9, 3.1, 49.1]);
    const wide = boundsRadiusM([2, 48, 4, 50]);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("is zero for a degenerate point bounds", () => {
    expect(boundsRadiusM([3, 49, 3, 49])).toBe(0);
  });
});

describe("bearing", () => {
  const origin = { lat: 0, lon: 0 };

  it("points north", () => {
    expect(bearing(origin, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
  });

  it("points east", () => {
    expect(bearing(origin, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
  });

  it("points south", () => {
    expect(bearing(origin, { lat: -1, lon: 0 })).toBeCloseTo(180, 6);
  });

  it("points west", () => {
    expect(bearing(origin, { lat: 0, lon: -1 })).toBeCloseTo(270, 6);
  });

  it("points northeast for a small equal offset", () => {
    expect(bearing(origin, { lat: 0.001, lon: 0.001 })).toBeCloseTo(45, 2);
  });

  it("always returns [0, 360)", () => {
    for (const target of [
      { lat: 1, lon: -1 },
      { lat: -1, lon: -1 },
      { lat: -1, lon: 1 },
    ]) {
      const b = bearing(origin, target);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(360);
    }
  });
});

describe("compass", () => {
  it.each([
    [0, "N"],
    [45, "NE"],
    [90, "E"],
    [135, "SE"],
    [180, "S"],
    [225, "SW"],
    [270, "W"],
    [315, "NW"],
    [359, "N"],
    [360, "N"],
  ])("labels %d° as %s", (deg, label) => {
    expect(compass(deg)).toBe(label);
  });

  it("switches label at the 22.5° half-sector boundary", () => {
    expect(compass(22.4)).toBe("N");
    expect(compass(22.5)).toBe("NE");
    expect(compass(337.4)).toBe("NW");
    expect(compass(337.5)).toBe("N");
  });
});

describe("fmtDist", () => {
  it("renders feet below 1000 ft", () => {
    expect(fmtDist(0)).toBe("0 ft");
    expect(fmtDist(120.4)).toBe("395 ft");
  });

  it("renders miles from 1000 ft up", () => {
    expect(fmtDist(305)).toBe("0.19 mi");
    expect(fmtDist(1609.344)).toBe("1.00 mi");
    expect(fmtDist(5000)).toBe("3.11 mi");
  });
});

describe("maneuver", () => {
  it.each([
    [0, "Continue straight"],
    [19.9, "Continue straight"],
    [-19.9, "Continue straight"],
    [20, "Slight right"],
    [-20, "Slight left"],
    [44.9, "Slight right"],
    [45, "Turn right"],
    [-45, "Turn left"],
    [134.9, "Turn right"],
    [135, "Sharp right"],
    [-135, "Sharp left"],
    [159.9, "Sharp right"],
    [160, "U-turn"],
    [-180, "U-turn"],
  ])("maps %d° to %s", (angle, label) => {
    expect(maneuver(angle)).toBe(label);
  });
});

describe("turnSide", () => {
  it.each([
    [-90, "left"],
    [90, "right"],
    [-35, "left"],
    [35, "right"],
    [-180, "left"],
    [180, "right"],
  ])("maps %d° to %s", (angle, side) => {
    expect(turnSide(angle)).toBe(side);
  });
});

describe("pathLength", () => {
  const a = { lat: 0, lon: 0 };
  const b = { lat: 0, lon: 0.001 };
  const c = { lat: 0.001, lon: 0.001 };
  const leg = ONE_DEG_M / 1000;

  it("is zero for empty or single-point paths", () => {
    expect(pathLength([], false)).toBe(0);
    expect(pathLength([], true)).toBe(0);
    expect(pathLength([a], false)).toBe(0);
    expect(pathLength([a], true)).toBe(0);
  });

  it("sums open-path legs", () => {
    expect(pathLength([a, b, c], false)).toBeCloseTo(2 * leg, 3);
  });

  it("adds the closing leg when looping", () => {
    const open = pathLength([a, b, c], false);
    const closed = pathLength([a, b, c], true);
    expect(closed - open).toBeCloseTo(haversine(c, a), 6);
  });
});

describe("nearestCumDistOnPath", () => {
  // Straight path due east along the equator: [lon, lat] pairs.
  const path: [number, number][] = [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
  ];
  const M_PER_LON = 111320; // module's local equirectangular scale at lat 0

  it("returns 0 for degenerate paths", () => {
    expect(nearestCumDistOnPath([], { lat: 0, lon: 0.001 })).toBe(0);
    expect(nearestCumDistOnPath([[0.001, 0]], { lat: 0, lon: 0.001 })).toBe(0);
  });

  it("projects a point onto the middle of the path", () => {
    // Slightly north of the 3/4 mark; projection lands at lon 0.0015.
    const d = nearestCumDistOnPath(path, { lat: 0.0001, lon: 0.0015 });
    expect(d).toBeCloseTo(0.0015 * M_PER_LON, 0);
  });

  it("clamps before the start to 0", () => {
    expect(nearestCumDistOnPath(path, { lat: 0, lon: -0.01 })).toBe(0);
  });

  it("clamps past the end to the full length", () => {
    const d = nearestCumDistOnPath(path, { lat: 0, lon: 0.05 });
    expect(d).toBeCloseTo(0.002 * M_PER_LON, 0);
  });

  it("survives zero-length segments", () => {
    const withDup: [number, number][] = [
      [0, 0],
      [0.001, 0],
      [0.001, 0],
      [0.002, 0],
    ];
    const d = nearestCumDistOnPath(withDup, { lat: 0, lon: 0.0015 });
    expect(d).toBeCloseTo(0.0015 * M_PER_LON, 0);
  });

  describe("with a window", () => {
    // Out-and-back along the equator: east 0.003° (≈334 m), then straight back.
    const outAndBack: [number, number][] = [
      [0, 0],
      [0.003, 0],
      [0, 0],
    ];
    const turnaround = 0.003 * M_PER_LON;
    const onTheWayBack = { lat: 0, lon: 0.001 };

    it("snaps a retraced street to the first pass without one", () => {
      expect(nearestCumDistOnPath(outAndBack, onTheWayBack)).toBeCloseTo(0.001 * M_PER_LON, 0);
    });

    it("searches only the windowed stretch, clamped to its ends", () => {
      const d = nearestCumDistOnPath(outAndBack, onTheWayBack, [turnaround - 30, Infinity]);
      expect(d).toBeCloseTo(turnaround + 0.002 * M_PER_LON, 0);
    });

    it("falls back to the whole route when the fix is far off the window", () => {
      // The window hugs the turnaround, ~190 m from the fix: it is off route
      // as far as the window knows, so the whole route is searched.
      const d = nearestCumDistOnPath(outAndBack, onTheWayBack, [turnaround - 30, turnaround + 30]);
      expect(d).toBeCloseTo(0.001 * M_PER_LON, 0);
    });

    it("keeps a nearby fix inside the window's slack", () => {
      // The fix projects 40 m past the window's end: off the stretch itself,
      // but within its 30 m slack plus GPS error, so it is placed at the end of
      // the slack rather than anywhere else on the route.
      const end = 0.001 * M_PER_LON - 40;
      expect(nearestCumDistOnPath(outAndBack, onTheWayBack, [0, end])).toBeCloseTo(end + 30, 6);
    });

    it("prefers the stretch itself over its slack", () => {
      // On the way back, 10 m past the turnaround: the way out 10 m before it is
      // as near, and inside the slack of a window that starts at the turnaround.
      const justBack = { lat: 0, lon: 0.003 - 10 / M_PER_LON };
      const d = nearestCumDistOnPath(outAndBack, justBack, [turnaround, Infinity]);
      expect(d).toBeCloseTo(turnaround + 10, 0);
    });
  });
});

describe("stopsAlongPath", () => {
  const M_PER_LON = 111320;
  // East to a turnaround, back west past the start's meridian, then on to the west.
  const path: [number, number][] = [
    [0, 0],
    [0.003, 0],
    [-0.002, 0],
  ];

  it("places each stop on the pass after the previous stop", () => {
    // B sits on the street the route took on the way out to A, but it's visited
    // on the way back: after A, at 0.003 + 0.002 = 0.005° along.
    const A = { lat: 0, lon: 0.003 };
    const B = { lat: 0, lon: 0.001 };
    const [a, b] = stopsAlongPath(path, [A, B]);
    expect(a).toBeCloseTo(0.003 * M_PER_LON, 0);
    expect(b).toBeCloseTo(0.005 * M_PER_LON, 0);
    // A plain nearest-point search puts B on the way out.
    expect(nearestCumDistOnPath(path, B)).toBeCloseTo(0.001 * M_PER_LON, 0);
  });

  it("keeps twins at the same position", () => {
    const A = { lat: 0, lon: 0.002 };
    const [a, twin] = stopsAlongPath(path, [A, { ...A }]);
    expect(twin).toBe(a);
  });

  it("is all zeros on a degenerate path", () => {
    expect(stopsAlongPath([[0, 0]], [{ lat: 0, lon: 0 }])).toEqual([0]);
  });
});

describe("pointAtDistOnPath", () => {
  // Straight path due east along the equator.
  const path: [number, number][] = [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
  ];

  it("returns the start at/under zero distance", () => {
    expect(pointAtDistOnPath(path, 0)).toEqual([0, 0]);
    expect(pointAtDistOnPath(path, -50)).toEqual([0, 0]);
  });

  it("interpolates within a segment", () => {
    // Half of the first segment (≈111 m) lands at lon 0.0005.
    const [lon, lat] = pointAtDistOnPath(
      path,
      haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 0.0005 }),
    );
    expect(lon).toBeCloseTo(0.0005, 6);
    expect(lat).toBeCloseTo(0, 6);
  });

  it("clamps past the end to the last vertex", () => {
    expect(pointAtDistOnPath(path, 1e6)).toEqual([0.002, 0]);
  });

  it("skips zero-length segments", () => {
    const withDup: [number, number][] = [
      [0, 0],
      [0, 0],
      [0.001, 0],
    ];
    const [lon] = pointAtDistOnPath(
      withDup,
      haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 0.0005 }),
    );
    expect(lon).toBeCloseTo(0.0005, 6);
  });

  it("walks a 20,000-vertex route without exhausting the stack", () => {
    // ~1.1 m steps due east: long runs have this many vertices.
    const long: [number, number][] = Array.from({ length: 20_000 }, (_, i) => [i * 1e-5, 0]);
    expect(pointAtDistOnPath(long, 1e9)).toEqual(long[19_999]);
    const nearEnd = pointAtDistOnPath(long, haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 0.19 }));
    expect(nearEnd[0]).toBeCloseTo(0.19, 6);
  });
});

describe("routeHeadingAt", () => {
  it("returns null for a route too short to have a direction", () => {
    expect(routeHeadingAt([], { lat: 0, lon: 0 })).toBeNull();
    expect(routeHeadingAt([[0, 0]], { lat: 0, lon: 0 })).toBeNull();
  });

  it("follows a straight leg due east (≈90°)", () => {
    const path: [number, number][] = [
      [0, 0],
      [0.01, 0],
    ];
    expect(routeHeadingAt(path, { lat: 0, lon: 0.002 })).toBeCloseTo(90, 0);
  });

  it("gives the CURRENT leg's heading, not the crow-flies bearing to the end", () => {
    // L-shaped route: due north up to the corner, then due east away from it. A
    // runner partway up the first leg is heading north (0°) — even though the
    // straight line to the destination points north-east. This is the exact bug:
    // orient to the road you're on, not the diagonal to the goal.
    const L: [number, number][] = [
      [0, 0],
      [0, 0.01], // corner, due north
      [0.01, 0.01], // then due east
    ];
    const here: Pt = { lat: 0.002, lon: 0 }; // on the northbound leg
    const heading = routeHeadingAt(L, here, 25);
    expect(heading).toBeCloseTo(0, 0); // north, the current leg
    // Sanity: the crow-flies bearing to the destination is clearly north-EAST,
    // so the two genuinely differ.
    expect(bearing(here, { lat: 0.01, lon: 0.01 })).toBeGreaterThan(40);
  });

  it("looks back along the final leg at the route's end", () => {
    const path: [number, number][] = [
      [0, 0],
      [0.01, 0], // due east
    ];
    // Projecting at/past the last vertex: still resolves the eastbound heading.
    expect(routeHeadingAt(path, { lat: 0, lon: 0.01 })).toBeCloseTo(90, 0);
  });
});
