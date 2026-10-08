import { describe, expect, it } from "vitest";
import { planRoute, type PlanInput, type PlanNode, type PlanResult } from "../src/plan";
import { haversine, pathLength, type Pt } from "../src/geo";
import type { Fountain } from "../src/schemas";

// planRoute's 2-opt and auto-pickup score moves from a few local distances
// instead of re-summing the whole path per candidate. That must be a pure speed
// change: the same points picked, in the same order. This file keeps a frozen
// copy of the original whole-path implementation and checks the two agree on
// seeded random pools.

// ---- Frozen copy of the original algorithm (do not "fix" or optimise) ------
const DETOUR_FACTOR = 1.3;
const PICKUP_DETOUR_M = 150;

function legacyTotal(start: Pt, nodes: PlanNode[], loop: boolean): number {
  return pathLength([start, ...nodes], loop);
}

// 2-opt: reverse segments while it shortens the (open or closed) path.
function legacyTwoOpt(start: Pt, nodes: PlanNode[], loop: boolean): PlanNode[] {
  let best = nodes.slice();
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        if (legacyTotal(start, cand, loop) + 1e-6 < legacyTotal(start, best, loop)) {
          best = cand;
          improved = true;
        }
      }
    }
  }
  return best;
}

// Cheapest-insertion of leftover points that sit a tiny detour off the route.
// Each round inserts the single point with the smallest added length, as long as
// that detour stays under `maxCost` and (when targeting) keeps total under budget.
function legacyPickup(
  start: Pt,
  nodes: PlanNode[],
  loop: boolean,
  pool: Fountain[],
  maxCost: number,
  budget: number,
): { nodes: PlanNode[]; addedIds: number[] } {
  const cur = nodes.slice();
  const remaining = pool.slice();
  const addedIds: number[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    const base = legacyTotal(start, cur, loop);
    let bestCost = Infinity;
    let bestIdx = -1;
    let bestR = -1;
    for (let r = 0; r < remaining.length; r++) {
      const node: PlanNode = {
        lat: remaining[r].lat,
        lon: remaining[r].lon,
        fountain: remaining[r],
      };
      for (let idx = 0; idx <= cur.length; idx++) {
        const cand = cur.slice(0, idx).concat(node, cur.slice(idx));
        const delta = legacyTotal(start, cand, loop) - base;
        if (delta < bestCost) {
          bestCost = delta;
          bestIdx = idx;
          bestR = r;
        }
      }
    }
    if (bestR >= 0 && bestCost <= maxCost && base + bestCost <= budget) {
      const f = remaining[bestR];
      cur.splice(bestIdx, 0, { lat: f.lat, lon: f.lon, fountain: f });
      addedIds.push(f.id);
      remaining.splice(bestR, 1);
      progress = true;
    }
  }
  return { nodes: cur, addedIds };
}

function legacyPlanRoute({
  start,
  candidates,
  vias = [],
  pinned = [],
  targetM = 0,
  loop,
  autoPickup = true,
}: PlanInput): PlanResult {
  const hasTarget = targetM > 0;
  const budget = hasTarget ? targetM / DETOUR_FACTOR : Infinity;
  // Via-points and pinned marks are always included, even if they alone blow the budget.
  const order: PlanNode[] = [
    ...vias.map((v) => ({ lat: v.lat, lon: v.lon })),
    ...pinned.map((f) => ({ lat: f.lat, lon: f.lon, fountain: f })),
  ];
  const pinnedIds = new Set(pinned.map((f) => f.id));
  const remaining = candidates.filter((c) => !pinnedIds.has(c.id));
  let cur: Pt = order.length ? order[order.length - 1] : start;

  // Greedy fill only when a target distance is set; with no target the route is
  // defined purely by the pinned marks (and via-points).
  if (hasTarget) {
    while (remaining.length > 0) {
      remaining.sort((a, b) => haversine(cur, a) - haversine(cur, b));
      let added = false;
      for (let i = 0; i < remaining.length; i++) {
        const node: PlanNode = {
          lat: remaining[i].lat,
          lon: remaining[i].lon,
          fountain: remaining[i],
        };
        if (legacyTotal(start, [...order, node], loop) <= budget) {
          order.push(node);
          cur = remaining[i];
          remaining.splice(i, 1);
          added = true;
          break;
        }
      }
      if (!added) break; // nothing else fits
    }
  }

  let ordered = legacyTwoOpt(start, order, loop);

  // Auto-pickup: grab any leftover point a tiny detour off the planned route.
  // Skip when the route is empty (no anchors) so we don't grab around the start.
  const autoIds: number[] = [];
  if (autoPickup && ordered.length > 0) {
    const grabbed = legacyPickup(start, ordered, loop, remaining, PICKUP_DETOUR_M, budget);
    ordered = legacyTwoOpt(start, grabbed.nodes, loop);
    autoIds.push(...grabbed.addedIds);
  }

  return { ordered, estM: legacyTotal(start, ordered, loop), autoIds };
}
// ---- End of frozen copy -----------------------------------------------------

// Small deterministic PRNG (mulberry32) so failures reproduce.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START: Pt = { lat: 48.8566, lon: 2.3522 };
const M_PER_DEG_LAT = 111_195;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((START.lat * Math.PI) / 180);

// A point uniformly inside a disc of `radiusM` around START.
function pointIn(rand: () => number, radiusM: number): Pt {
  const r = radiusM * Math.sqrt(rand());
  const th = 2 * Math.PI * rand();
  return {
    lat: START.lat + (r * Math.sin(th)) / M_PER_DEG_LAT,
    lon: START.lon + (r * Math.cos(th)) / mPerDegLon,
  };
}

type Scenario = {
  seed: number;
  n: number;
  poolRadiusM: number;
  pins: number;
  pinRadiusM: number;
  loop: boolean;
  vias?: number;
  targetM?: number;
};

function build(s: Scenario): PlanInput {
  const { seed, n, poolRadiusM, pins, pinRadiusM, loop, vias = 0, targetM = 0 } = s;
  const rand = rng(seed);
  const pool: Fountain[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ...pointIn(rand, poolRadiusM),
    tags: {},
  }));
  const near = pool.filter((f) => haversine(START, f) <= pinRadiusM);
  const pinned: Fountain[] = [];
  while (pinned.length < Math.min(pins, near.length)) {
    const f = near[Math.floor(rand() * near.length)];
    if (!pinned.includes(f)) pinned.push(f);
  }
  // OSM has the odd pair of nodes at identical coordinates. A twin of a pin
  // costs exactly 0 on both edges around it, and twins in the pool tie each
  // other exactly, so these pin down the tie-breaking order as well.
  const twins = [...pinned.slice(0, 1), ...near.slice(0, 2)];
  twins.forEach((t, i) => pool.push({ id: 10_000 + i, lat: t.lat, lon: t.lon, tags: {} }));
  return {
    start: START,
    candidates: pool,
    pinned,
    vias: Array.from({ length: vias }, () => pointIn(rand, pinRadiusM)),
    targetM,
    loop,
  };
}

const ids = (r: PlanResult) => r.ordered.map((n) => n.fountain?.id ?? "via");
const coords = (nodes: PlanNode[]) => nodes.map((n) => `${n.lat},${n.lon}`);

function expectSamePlan(actual: PlanResult, expected: PlanResult, loop: boolean) {
  expect(actual.autoIds).toEqual(expected.autoIds);
  expect(Math.abs(actual.estM - expected.estM)).toBeLessThan(1e-6);
  if (ids(actual).join() === ids(expected).join()) return;
  // The one allowed difference: a loop driven the other way round. On an
  // out-and-back (one anchor, or a pin plus its twin) inserting a point on the
  // way out or on the way back costs exactly the same, and the original broke
  // that tie by floating-point rounding in its whole-path sums; the new code
  // takes the earlier edge. Twins may then swap places, so compare positions.
  expect(loop).toBe(true);
  expect(coords(actual.ordered)).toEqual(coords(expected.ordered).reverse());
}

const scenarios: Scenario[] = [];
let seed = 1;
const variants = (at: Omit<Scenario, "seed" | "pins" | "vias" | "targetM">) =>
  [
    { pins: 1, vias: 0, targetM: 0 },
    { pins: 3, vias: 0, targetM: 0 },
    { pins: 8, vias: 0, targetM: 0 },
    { pins: 2, vias: 2, targetM: 0 },
    { pins: 0, vias: 1, targetM: 0 },
    { pins: 2, vias: 0, targetM: 6_000 },
  ].forEach((v) => scenarios.push({ seed: seed++, ...at, ...v }));
for (const loop of [true, false]) {
  // The planner's default 4-mile pool, pinning points near the start.
  for (const n of [0, 1, 12, 60, 150, 300]) {
    variants({ n, loop, poolRadiusM: 6_437, pinRadiusM: 1_500 });
  }
  // Dense pools (a point every block or so): pickup chains along the route,
  // which exercises many rounds of cached-edge updates.
  for (const n of [12, 40, 100]) {
    variants({ n, loop, poolRadiusM: n <= 40 ? 600 : 1_200, pinRadiusM: 600 });
  }
  // Pins spread across the whole pool snowball into long routes and long 2-opt passes.
  const spread = { n: 200, loop, poolRadiusM: 6_437, pinRadiusM: 6_437, vias: 0 };
  scenarios.push({ seed: seed++, ...spread, pins: 6, targetM: 0 });
  scenarios.push({ seed: seed++, ...spread, pins: 3, targetM: 12_000 });
}

describe("planRoute matches the original whole-path implementation", () => {
  it.each(scenarios)(
    "n=$n r=$poolRadiusM pins=$pins vias=$vias targetM=$targetM loop=$loop (seed $seed)",
    (s) => {
      const input = build(s);
      expectSamePlan(planRoute(input), legacyPlanRoute(input), s.loop);
    },
  );

  it("agrees with auto-pickup off", () => {
    const input = {
      ...build({ seed: 99, n: 150, poolRadiusM: 1_500, pins: 5, pinRadiusM: 1_500, loop: true }),
      autoPickup: false,
    };
    expectSamePlan(planRoute(input), legacyPlanRoute(input), true);
  });
});

describe("planRoute performance", () => {
  // Loose guard against reintroducing whole-path re-sums. This pool took over
  // half a second with them and takes around 10 ms without (Node with a JIT;
  // expect several times that on Hermes).
  it("plans a 1,000-point pool with 5 nearby pins in well under 100 ms", () => {
    const input = build({
      seed: 7,
      n: 1_000,
      poolRadiusM: 6_437,
      pins: 5,
      pinRadiusM: 1_500,
      loop: true,
    });
    planRoute(input); // warm up the JIT
    const t0 = performance.now();
    const res = planRoute(input);
    const ms = performance.now() - t0;
    expect(res.ordered.length).toBeGreaterThan(5);
    expect(ms).toBeLessThan(100);
  });
});
