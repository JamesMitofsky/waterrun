// Route planning: pick + order a subset of points that fits a distance budget.
// This is an orienteering problem (prize-collecting TSP with a length cap) — NP-hard,
// so we use a greedy nearest-neighbor build under the budget, then 2-opt to tidy order.
// Optional via-points are mandatory anchors the route must pass through (not survey targets).
import { haversine, pathLength, type Pt } from "./geo";
import type { Fountain } from "./schemas";

// Straight-line distance underestimates real street routes; inflate the budget
// check by this factor so the BRouter result tends to land under target.
const DETOUR_FACTOR = 1.3;

// Max straight-line distance a leftover point may add to the route to still be
// auto-grabbed. "Small deviation" — a point this close is nearly free to verify.
const PICKUP_DETOUR_M = 150;

// A node in the ordered route. `fountain` set => survey target; absent => via-point.
export type PlanNode = { lat: number; lon: number; fountain?: Fountain };

export type PlanInput = {
  start: Pt;
  candidates: Fountain[];
  vias?: Pt[]; // mandatory pass-through points (not survey targets)
  pinned?: Fountain[]; // marks the user requires in the route (survey targets)
  // Desired run distance (street meters). 0/undefined => no target: the route is
  // sized purely by the pinned marks (and via-points), no greedy distance-fill.
  targetM?: number;
  loop: boolean;
  autoPickup?: boolean; // grab leftover points a tiny detour off the route (default true)
};

export type PlanResult = {
  ordered: PlanNode[]; // vias + chosen fountains, in visit order
  estM: number; // straight-line estimate (meters)
  autoIds: number[]; // fountain ids auto-added via small-detour pickup
};

function total(start: Pt, nodes: PlanNode[], loop: boolean): number {
  return pathLength([start, ...nodes], loop);
}

// Reverse a[i..k] in place.
function reverseRange<T>(a: T[], i: number, k: number) {
  for (; i < k; i++, k--) {
    const t = a[i];
    a[i] = a[k];
    a[k] = t;
  }
}

// 2-opt: reverse segments while it shortens the (open or closed) path.
// Reversing nodes[i..k] only swaps the two edges at the segment's ends: its
// interior keeps the same length because haversine is exactly symmetric. So
// each candidate move is scored from four distances instead of re-summing the
// whole path, which made a pass O(n³) and froze the JS thread on long routes.
function twoOpt(start: Pt, nodes: PlanNode[], loop: boolean): PlanNode[] {
  const best = nodes.slice();
  const n = best.length;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const prev = i === 0 ? start : best[i - 1];
        // An open path's last node has no outgoing edge to swap.
        const next = k < n - 1 ? best[k + 1] : loop ? start : null;
        let gain = haversine(prev, best[i]) - haversine(prev, best[k]);
        if (next) gain += haversine(best[k], next) - haversine(best[i], next);
        if (gain > 1e-6) {
          reverseRange(best, i, k);
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
//
// Rescoring every candidate against every edge each round made this O(m·n²) per
// pick, and pickup snowballs (each pick adds edges that bring neighbours within
// reach), so a marker tap could block the JS thread for seconds. Instead each
// candidate caches its cheapest edge. Inserting p into a→b only replaces that
// edge with a→p and p→b: a candidate whose best edge was elsewhere compares
// against the two new edges, and only those that were cheapest on a→b rescan
// the route. The picks match a full rescan exactly, ties included (lowest pool
// index, then earliest edge), because every cost is the same three-distance
// sum a full rescan computes.
function pickup(
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
  // Edge i runs from start (i = 0) or cur[i - 1] to cur[i], or past the last
  // node back to start (loop) or nowhere (an open path's end, where a point is
  // simply appended: a zero-length edge to nothing).
  const from = (i: number): Pt => (i === 0 ? start : cur[i - 1]);
  const to = (i: number): Pt | null => (i < cur.length ? cur[i] : loop ? start : null);
  const len = Array.from({ length: cur.length + 1 }, (_, i) => {
    const b = to(i);
    return b ? haversine(from(i), b) : 0;
  });

  // Each candidate's cheapest insertion: the length it adds, and at which edge.
  // Inserting q into a→b adds d(a,q) + d(q,b) − d(a,b).
  const cost: number[] = [];
  const edge: number[] = [];
  const scan = (r: number) => {
    const q = remaining[r];
    cost[r] = Infinity;
    let dFrom = haversine(start, q);
    for (let i = 0; i <= cur.length; i++) {
      const b = to(i);
      const dTo = b ? haversine(q, b) : 0;
      const c = dFrom + dTo - len[i];
      if (c < cost[r]) {
        cost[r] = c;
        edge[r] = i;
      }
      // This edge's end is the next one's start (haversine is symmetric).
      dFrom = dTo;
    }
  };
  for (let r = 0; r < remaining.length; r++) scan(r);

  for (;;) {
    let bestR = -1;
    let bestCost = Infinity;
    for (let r = 0; r < remaining.length; r++) {
      if (cost[r] < bestCost) {
        bestCost = cost[r];
        bestR = r;
      }
    }
    const base = total(start, cur, loop);
    if (bestR < 0 || bestCost > maxCost || base + bestCost > budget) break;

    const f = remaining[bestR];
    const at = edge[bestR];
    const a = from(at);
    const b = to(at);
    const p: PlanNode = { lat: f.lat, lon: f.lon, fountain: f };
    cur.splice(at, 0, p);
    len.splice(at, 1, haversine(a, p), b ? haversine(p, b) : 0);
    addedIds.push(f.id);
    remaining.splice(bestR, 1);
    cost.splice(bestR, 1);
    edge.splice(bestR, 1);

    // Edge `at` is now a→p, p→b follows it, and every later edge shifts up one.
    for (let r = 0; r < remaining.length; r++) {
      if (edge[r] === at) {
        scan(r);
        continue;
      }
      if (edge[r] > at) edge[r]++;
      const q = remaining[r];
      const dQP = haversine(q, p);
      const viaA = haversine(a, q) + dQP - len[at];
      if (viaA < cost[r] || (viaA === cost[r] && at < edge[r])) {
        cost[r] = viaA;
        edge[r] = at;
      }
      const viaP = dQP + (b ? haversine(q, b) : 0) - len[at + 1];
      if (viaP < cost[r] || (viaP === cost[r] && at + 1 < edge[r])) {
        cost[r] = viaP;
        edge[r] = at + 1;
      }
    }
  }
  return { nodes: cur, addedIds };
}

export function planRoute({
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
    // Length of start→…→cur, summed in path order like total() does, so each fit
    // check is one or two haversines instead of a re-sum of the whole route.
    let openM = total(start, order, false);
    while (remaining.length > 0) {
      remaining.sort((a, b) => haversine(cur, a) - haversine(cur, b));
      let added = false;
      for (let i = 0; i < remaining.length; i++) {
        const leg = haversine(cur, remaining[i]);
        const closing = loop ? haversine(remaining[i], start) : 0;
        if (openM + leg + closing <= budget) {
          order.push({ lat: remaining[i].lat, lon: remaining[i].lon, fountain: remaining[i] });
          openM += leg;
          cur = remaining[i];
          remaining.splice(i, 1);
          added = true;
          break;
        }
      }
      if (!added) break; // nothing else fits
    }
  }

  let ordered = twoOpt(start, order, loop);

  // Auto-pickup: grab any leftover point a tiny detour off the planned route.
  // Skip when the route is empty (no anchors) so we don't grab around the start.
  const autoIds: number[] = [];
  if (autoPickup && ordered.length > 0) {
    const grabbed = pickup(start, ordered, loop, remaining, PICKUP_DETOUR_M, budget);
    ordered = twoOpt(start, grabbed.nodes, loop);
    autoIds.push(...grabbed.addedIds);
  }

  return { ordered, estM: total(start, ordered, loop), autoIds };
}
