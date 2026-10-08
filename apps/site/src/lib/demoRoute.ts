// Frozen demo data for the landing hero run map (extracted verbatim from the
// original DemoRunMap): a real DC foot loop of roughly 23.5 km + its OSM
// fountains. The loop starts and ends at Meridian Hill Park, which is drawn
// as the start flag rather than listed as a stop: a run's start is a place,
// not a point to survey.
import type { Fountain } from "@water-run/core/schemas";
import type { StopStatus } from "@water-run/core/stores/run";
import { ROUTE_LINE } from "@/lib/basemap/routeLine";

export const DC_CENTER: [number, number] = [38.9068, -77.0331];

/** Today's date `months` months back, as an OSM `check_date` (YYYY-MM-DD). */
function isoDateMonthsAgo(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export const DC_FOUNTAINS: Fountain[] = [
  {
    id: 1,
    lat: 38.91665,
    lon: -77.02586,
    tags: { name: "LeDroit Park", check_date: "2021-03-02" },
  },
  {
    id: 2,
    lat: 38.90981,
    lon: -77.02821,
    tags: { name: "Logan Circle", check_date: "2018-09-27" },
  },
  {
    id: 3,
    lat: 38.90998,
    lon: -77.03762,
    // The stop the replay hands the visitor (`DEMO_NEXT_STOP`): checked a
    // while ago, so its popup reads as a point due another look — not so
    // long that it reads as abandoned. Relative to today rather than a fixed
    // date, so it does not age.
    tags: { name: "Stead Park", check_date: isoDateMonthsAgo(5) },
  },
  {
    id: 4,
    lat: 38.88672,
    lon: -76.99649,
    tags: { name: "Lincoln Park", check_date: "2020-05-11" },
  },
  { id: 5, lat: 38.8831, lon: -76.99871, tags: { name: "Folger Park" } },
  {
    id: 6,
    lat: 38.88887,
    lon: -77.01979,
    tags: { name: "National Mall", check_date: "2017-08-19" },
  },
  { id: 7, lat: 38.88897, lon: -77.02442, tags: { name: "Smithsonian Castle" } },
  { id: 8, lat: 38.90495, lon: -77.06792, tags: { name: "Georgetown Waterfront" } },
  {
    id: 9,
    lat: 38.91023,
    lon: -77.06672,
    tags: { name: "Montrose Park", check_date: "2022-11-03" },
  },
];

// The run as recorded: a loop (first and last points coincide), one vertex
// every few metres, every kerb and jog. It leaves point 1 straight down 15th
// and comes home to it on the diagonal from 16th & W, one open turn at the
// stop. (It used to hook round the north side of Meridian Hill Park at one end
// or the other — a hairpin at the stop, and before that a crossing.)
//
// Not what is drawn: see `DC_ROUTE` below.
const DC_ROUTE_TRACE: [number, number][] = [
  [38.92547, -77.03219],
  [38.92236, -77.03189],
  [38.92114, -77.03011],
  [38.92064, -77.02961],
  [38.92048, -77.02948],
  [38.91926, -77.02888],
  [38.91915, -77.02818],
  [38.91805, -77.02808],
  [38.91711, -77.028],
  [38.91712, -77.02698],
  [38.91691, -77.02693],
  [38.91665, -77.02591],
  [38.91567, -77.02627],
  [38.91551, -77.02636],
  [38.91477, -77.02692],
  [38.91459, -77.02717],
  [38.91403, -77.02719],
  [38.91375, -77.02717],
  [38.91343, -77.02719],
  [38.91276, -77.02767],
  [38.91255, -77.02773],
  [38.91186, -77.02818],
  [38.91121, -77.02817],
  [38.91032, -77.02816],
  [38.91008, -77.0282],
  [38.90972, -77.02873],
  [38.90957, -77.02877],
  [38.90969, -77.02942],
  [38.90978, -77.02975],
  [38.90973, -77.03036],
  [38.90972, -77.03082],
  [38.90973, -77.0318],
  [38.90977, -77.03212],
  [38.90975, -77.03466],
  [38.90972, -77.03638],
  [38.90973, -77.03721],
  [38.90973, -77.03644],
  [38.90942, -77.03641],
  [38.90866, -77.03633],
  [38.90756, -77.03627],
  [38.90733, -77.03604],
  [38.90714, -77.0358],
  [38.90695, -77.03535],
  [38.90651, -77.03472],
  [38.90637, -77.03434],
  [38.90572, -77.03263],
  [38.90577, -77.03247],
  [38.9056, -77.0321],
  [38.90533, -77.03195],
  [38.90521, -77.03178],
  [38.90505, -77.03065],
  [38.90467, -77.02949],
  [38.90422, -77.02817],
  [38.90395, -77.02734],
  [38.9037, -77.02719],
  [38.90368, -77.02691],
  [38.9035, -77.02607],
  [38.90331, -77.02552],
  [38.90282, -77.0241],
  [38.90285, -77.02381],
  [38.90288, -77.02278],
  [38.90241, -77.02229],
  [38.90223, -77.02179],
  [38.90205, -77.02122],
  [38.90165, -77.02005],
  [38.90143, -77.0194],
  [38.90141, -77.01901],
  [38.90133, -77.01881],
  [38.90064, -77.01719],
  [38.90037, -77.01626],
  [38.90026, -77.01574],
  [38.89998, -77.01515],
  [38.89975, -77.01449],
  [38.89945, -77.01354],
  [38.89925, -77.01305],
  [38.89899, -77.01231],
  [38.89875, -77.01188],
  [38.89841, -77.01106],
  [38.89819, -77.01049],
  [38.89772, -77.00923],
  [38.89724, -77.00813],
  [38.89717, -77.00779],
  [38.89713, -77.00763],
  [38.89723, -77.00732],
  [38.89681, -77.00542],
  [38.89652, -77.00526],
  [38.89588, -77.00487],
  [38.89539, -77.00363],
  [38.89496, -77.00264],
  [38.8948, -77.00204],
  [38.89454, -77.0016],
  [38.8942, -77.00071],
  [38.8942, -77.00051],
  [38.89405, -77.00048],
  [38.89373, -76.9999],
  [38.89344, -76.99962],
  [38.89338, -76.99899],
  [38.89311, -76.99855],
  [38.89299, -76.99846],
  [38.89237, -76.99677],
  [38.89202, -76.99627],
  [38.88991, -76.99626],
  [38.88863, -76.99626],
  [38.88753, -76.99624],
  [38.88725, -76.99632],
  [38.88651, -76.99635],
  [38.88644, -76.99618],
  [38.88521, -76.99617],
  [38.88468, -76.9956],
  [38.88441, -76.99507],
  [38.88431, -76.9947],
  [38.88438, -76.99411],
  [38.88437, -76.99485],
  [38.88441, -76.99507],
  [38.88405, -76.9951],
  [38.88407, -76.99548],
  [38.88396, -76.99571],
  [38.8838, -76.99608],
  [38.8832, -76.99836],
  [38.88314, -76.99867],
  [38.88315, -77.00067],
  [38.88315, -77.00213],
  [38.88315, -77.0036],
  [38.88316, -77.00598],
  [38.88323, -77.00647],
  [38.88339, -77.00652],
  [38.88333, -77.00686],
  [38.88334, -77.00822],
  [38.88389, -77.00897],
  [38.88411, -77.00928],
  [38.88517, -77.01071],
  [38.88609, -77.01191],
  [38.88633, -77.01223],
  [38.88719, -77.01331],
  [38.88757, -77.01353],
  [38.88768, -77.01505],
  [38.88804, -77.01535],
  [38.88817, -77.01582],
  [38.88848, -77.01604],
  [38.88856, -77.01664],
  [38.88868, -77.01716],
  [38.88885, -77.01742],
  [38.88888, -77.01765],
  [38.88905, -77.01987],
  [38.89045, -77.02169],
  [38.89045, -77.02216],
  [38.88931, -77.02394],
  [38.88897, -77.02445],
  [38.88923, -77.02531],
  [38.89039, -77.02584],
  [38.89032, -77.03176],
  [38.89009, -77.03291],
  [38.88994, -77.03326],
  [38.89016, -77.03418],
  [38.89009, -77.03507],
  [38.89018, -77.0359],
  [38.89002, -77.03657],
  [38.89007, -77.03705],
  [38.89071, -77.03769],
  [38.89156, -77.03857],
  [38.89194, -77.03948],
  [38.89223, -77.04077],
  [38.89276, -77.04174],
  [38.89353, -77.04314],
  [38.89377, -77.04364],
  [38.89465, -77.04511],
  [38.89543, -77.04655],
  [38.89593, -77.04758],
  [38.89611, -77.0479],
  [38.89664, -77.04887],
  [38.89724, -77.04997],
  [38.89799, -77.05135],
  [38.89827, -77.05184],
  [38.89841, -77.05211],
  [38.89895, -77.05309],
  [38.89929, -77.0538],
  [38.8994, -77.05405],
  [38.9005, -77.05601],
  [38.90048, -77.05624],
  [38.90049, -77.05652],
  [38.90078, -77.05704],
  [38.90091, -77.05735],
  [38.90104, -77.05799],
  [38.9008, -77.05844],
  [38.90088, -77.05903],
  [38.90121, -77.06006],
  [38.90155, -77.06111],
  [38.90171, -77.06134],
  [38.90245, -77.06266],
  [38.9028, -77.06394],
  [38.90358, -77.06645],
  [38.90433, -77.06794],
  [38.90458, -77.0678],
  [38.90498, -77.06793],
  [38.90494, -77.06856],
  [38.90514, -77.06883],
  [38.90584, -77.06906],
  [38.90641, -77.07029],
  [38.90692, -77.07085],
  [38.90742, -77.07126],
  [38.90762, -77.0717],
  [38.90771, -77.07205],
  [38.90775, -77.07173],
  [38.90862, -77.07164],
  [38.90872, -77.06918],
  [38.90881, -77.06792],
  [38.90982, -77.06701],
  [38.91022, -77.06673],
  [38.91077, -77.06612],
  [38.91081, -77.06504],
  [38.9105, -77.06438],
  [38.91052, -77.06373],
  [38.91055, -77.06189],
  [38.91058, -77.05918],
  [38.91061, -77.05723],
  [38.91063, -77.05587],
  [38.91067, -77.05303],
  [38.91074, -77.05153],
  [38.91112, -77.05082],
  [38.91122, -77.05057],
  [38.91141, -77.04892],
  [38.91163, -77.0488],
  [38.91172, -77.04875],
  [38.9121, -77.04819],
  [38.91267, -77.04765],
  [38.9133, -77.04725],
  [38.91362, -77.04707],
  [38.91403, -77.04674],
  [38.91441, -77.04635],
  [38.91454, -77.04612],
  [38.9159, -77.04615],
  [38.9163, -77.0462],
  [38.9177, -77.04552],
  [38.91862, -77.04496],
  [38.91918, -77.04459],
  [38.91967, -77.04426],
  [38.92013, -77.04404],
  [38.9203, -77.04395],
  [38.92047, -77.04387],
  [38.92067, -77.04377],
  [38.92206, -77.04318],
  [38.92232, -77.04298],
  [38.92255, -77.04254],
  [38.923, -77.04199],
  [38.92315, -77.0418],
  [38.92397, -77.04056],
  [38.92481, -77.03919],
  [38.92474, -77.03847],
  [38.92477, -77.03781],
  [38.92486, -77.03539],
  [38.92547, -77.03219],
];

/**
 * How far the drawn route may stray from the trace, in metres.
 *
 * The hero shows the whole loop at a zoom where a pixel is some forty metres,
 * so the trace's finest detail — the wobble of a recorded track, a kerb cut,
 * the two sides of a street it doubled back along — is sub-pixel noise that
 * only shows as kinks. Half a pixel takes that out and nothing more: at this
 * tolerance every street the run took is still the street the line follows.
 * Anything much coarser lets a segment cut the corner of a block, and at
 * thirty metres a doubled-back block near Stead Park is folded into a
 * crossing. The live run screen draws its own route from its own data at
 * street zoom.
 */
const ROUTE_TOLERANCE_M = 20;

/** Metres per degree of latitude, and of longitude at DC's latitude. */
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((DC_CENTER[0] * Math.PI) / 180);

/** Distance in metres from `p` to the segment `a`–`b`, all as [lat, lon]. */
function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]) {
  const px = (p[1] - a[1]) * M_PER_DEG_LON;
  const py = (p[0] - a[0]) * M_PER_DEG_LAT;
  const dx = (b[1] - a[1]) * M_PER_DEG_LON;
  const dy = (b[0] - a[0]) * M_PER_DEG_LAT;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
  return Math.hypot(px - t * dx, py - t * dy);
}

/**
 * Douglas–Peucker over `trace`, keeping every index in `anchors` as well as the
 * two ends. The simplification runs between consecutive anchors, so an anchor
 * is never dropped and the line always passes through it.
 */
function simplifyRoute(
  trace: [number, number][],
  anchors: Iterable<number>,
  toleranceM: number,
): [number, number][] {
  const keep = new Set<number>([0, trace.length - 1, ...anchors]);
  const kept = [...keep].sort((a, b) => a - b);
  // Spans still to look at, each between two kept vertices.
  const stack: [number, number][] = kept.slice(1).map((to, k) => [kept[k], to]);
  while (stack.length) {
    const [from, to] = stack.pop()!;
    let farthest = -1;
    let farthestD = toleranceM;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegment(trace[i], trace[from], trace[to]);
      if (d > farthestD) {
        farthestD = d;
        farthest = i;
      }
    }
    if (farthest !== -1) {
      keep.add(farthest);
      stack.push([from, farthest], [farthest, to]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((i) => trace[i]);
}

/** The trace vertex nearest each fountain: where the drawn line must pass. */
const stopAnchors = DC_FOUNTAINS.map((f) => {
  let best = 0;
  let bestD = Infinity;
  DC_ROUTE_TRACE.forEach(([lat, lon], i) => {
    const d = Math.hypot((lon - f.lon) * M_PER_DEG_LON, (lat - f.lat) * M_PER_DEG_LAT);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
});

/**
 * The route as drawn — the trace with its street-level kinks taken out (see
 * `ROUTE_TOLERANCE_M`), still passing through every stop. Computed once at
 * module load; both the live map and the loading frame's placeholder draw
 * this, so they agree vertex for vertex.
 */
export const DC_ROUTE: [number, number][] = simplifyRoute(
  DC_ROUTE_TRACE,
  stopAnchors,
  ROUTE_TOLERANCE_M,
);

// Same palette as the live run screen.
export const STATUS_COLOR: Record<StopStatus, string> = {
  pending: "#9ca3af",
  confirm: "#16a34a",
  broken: "#f59e0b",
  out_of_order: "#d97706",
  removed: "#dc2626",
  skipped: "#6b7280",
};

// The run the hero replays. The first stops have been surveyed; the replay
// (`DemoRunMap`, geometry in `demoRun.ts`) reveals each of these as the line
// reaches its stop, then runs on to `DEMO_NEXT_STOP` and halts there with the
// point pulsing, ready to be marked. These are not what the map shows on
// load: every stop starts pending, and only flips once the runner gets there.
//
// Every stop listed here must come before `DEMO_NEXT_STOP` on the route, and
// that stop must not be listed: `demoRun.ts` checks both at load.
export const SEED_STATUSES: Record<number, StopStatus> = {
  1: "out_of_order",
  2: "confirm",
};

/**
 * The stop the replay ends on: the runner arrives here, still unmarked, and
 * the stop pulses until the visitor opens it — the cue that this is theirs to
 * mark.
 */
export const DEMO_NEXT_STOP = 3;

/**
 * The colour a stop's dot is drawn in. A stop with a status wears its status,
 * and one without is pending grey — except `DEMO_NEXT_STOP` once the run has
 * come to rest there (`halted`), which wears the route's blue until it is
 * marked: the run's own colour, on the one stop the visitor is being handed.
 *
 * Shared by the live map (`DemoRunMap`) and its loading frame
 * (`DemoRoutePlaceholder`), so the two agree on when the stop turns.
 */
export function demoStopColor(id: number, status: StopStatus | undefined, halted: boolean): string {
  if (status) return STATUS_COLOR[status];
  return halted && id === DEMO_NEXT_STOP ? ROUTE_LINE.color : STATUS_COLOR.pending;
}
