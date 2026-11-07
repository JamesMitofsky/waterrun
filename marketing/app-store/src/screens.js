// Recreations of Water Run's iOS screens, drawn at the iPhone 17 Pro Max's
// 440 x 956 pt. Every string, colour and size here is read off the app's own
// components (apps/mobile/src) so the art shows the product as it is:
//   Nearby        app/(tabs)/quick-update.tsx, map/WaterRunMap.tsx
//   Planner       app/(tabs)/plan.tsx, components/planner/RouteBuilderPanel.tsx
//   Run           app/run.tsx
//   Survey sheet  components/PointSheet.tsx
//   Live Activity widgets/RunProgressActivity.tsx
// Maps are pre-rendered (scripts/render-maps.mjs); routes and markers are drawn
// here, projected with the same Web Mercator maths MapLibre uses.

import { ICONS } from "./icons.js";

export const icon = (name, size, color, weight = "bold", extra = "") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="${color}" ${extra}>${ICONS[`${name}:${weight}`]}</svg>`;

// --- data ---------------------------------------------------------------

export async function loadData(base = "..") {
  const get = (p) => fetch(`${base}/${p}`).then((r) => r.json());
  const run = await get("src/dc-run.json");
  const names = [
    "app-nearby",
    "app-plan",
    "app-run",
    "paper-loop",
    "paper-street",
    "night-pano",
    "night-tall",
    "enamel-street",
    "enamel-loop",
  ];
  const maps = Object.fromEntries(
    await Promise.all(names.map(async (n) => [n, await get(`assets/maps/${n}.json`)])),
  );
  // The fountains in the order the loop reaches them.
  const along = (f) => {
    let best = 0,
      bd = Infinity;
    run.trace.forEach(([la, lo], i) => {
      const d = (la - f.lat) ** 2 + (lo - f.lon) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  run.stops = [...run.fountains].sort((a, b) => along(a) - along(b));
  return { run, maps, base };
}

export function project(view, lat, lon) {
  const ws = 512 * 2 ** view.zoom;
  const X = (l) => ((l + 180) / 360) * ws;
  const Y = (la) => {
    const s = Math.sin((la * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * ws;
  };
  return [
    X(lon) - X(view.center[0]) + view.width / 2,
    Y(lat) - Y(view.center[1]) + view.height / 2,
  ];
}

export const pathD = (view, pts) =>
  pts
    .map(([la, lo], i) => {
      const [x, y] = project(view, la, lo);
      return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");

// Status palette, from packages/core/src/editStatus.ts and fountainFilters.ts.
export const STATUS = {
  confirm: { color: "#16a34a", label: "✓", text: "Working" },
  broken: { color: "#f59e0b", label: "⚡", text: "Partially working" },
  out_of_order: { color: "#d97706", label: "!", text: "Out of order" },
  removed: { color: "#dc2626", label: "✕", text: "Removed" },
  pending: { color: "#9ca3af", label: "", text: "Not surveyed" },
  skipped: { color: "#6b7280", label: "", text: "Skipped" },
};
export const FRESH = { fresh: "#16a34a", aging: "#f97316", old: "#ef4444", retired: "#9ca3af" };

// A MapLibre circle marker: r 9, white 2 pt stroke, optional white label.
export const marker = (x, y, color, label = "", r = 9) => `
  <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
    <circle r="${r}" fill="${color}" stroke="#fff" stroke-width="2"/>
    ${label ? `<text y="3.8" text-anchor="middle" font-family="Inter" font-weight="700" font-size="11" fill="#fff">${label}</text>` : ""}
  </g>`;

export const userDot = (x, y) => `
  <g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
    <circle r="26" fill="#1d7bf2" opacity="0.14"/>
    <circle r="11" fill="#fff" />
    <circle r="7.5" fill="#1d7bf2"/>
  </g>`;

// --- chrome ---------------------------------------------------------------

export function statusBar({ dark = false, time = "9:41", island = true } = {}) {
  const ink = dark ? "#fff" : "#000";
  return `
  <div style="position:absolute;left:0;right:0;top:0;height:54px;z-index:20;pointer-events:none">
    <div style="position:absolute;left:54px;top:17px;font:600 17px/22px Inter;letter-spacing:-0.02em;color:${ink}">${time}</div>
    ${island ? `<div style="position:absolute;left:157px;top:11px;width:126px;height:37px;border-radius:20px;background:#000"></div>` : ""}
    <div style="position:absolute;right:30px;top:20px;display:flex;gap:7px;align-items:center">
      <svg width="19" height="12" viewBox="0 0 19 12" fill="${ink}"><rect x="0" y="8" width="3.2" height="4" rx="1"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="1"/><rect x="10" y="3" width="3.2" height="9" rx="1"/><rect x="15" y="0" width="3.2" height="12" rx="1"/></svg>
      <svg width="17" height="12" viewBox="0 0 17 12" fill="${ink}"><path d="M8.5 2.4c2.3 0 4.4.9 6 2.4l1.2-1.3A10.4 10.4 0 0 0 8.5.6 10.4 10.4 0 0 0 1.3 3.5l1.2 1.3c1.6-1.5 3.7-2.4 6-2.4Zm0 3.6c1.3 0 2.5.5 3.4 1.3l1.2-1.3A6.7 6.7 0 0 0 8.5 4.2 6.7 6.7 0 0 0 3.9 6l1.2 1.3c.9-.8 2.1-1.3 3.4-1.3Zm0 3.5 2-2.1a3 3 0 0 0-4 0Z"/></svg>
      <svg width="28" height="13" viewBox="0 0 28 13"><rect x="0.5" y="0.5" width="24" height="12" rx="3.8" fill="none" stroke="${ink}" opacity="0.4"/><rect x="2" y="2" width="19" height="9" rx="2.4" fill="${ink}"/><path d="M26 4.3v4.4c.9-.3 1.5-1.2 1.5-2.2S26.9 4.6 26 4.3Z" fill="${ink}" opacity="0.45"/></svg>
    </div>
  </div>`;
}

export const homeBar = (dark = false) =>
  `<div style="position:absolute;left:150px;bottom:8px;width:140px;height:5px;border-radius:3px;background:${dark ? "#fff" : "#000"};z-index:30"></div>`;

// iOS 26 floating tab bar (expo-router NativeTabs → SwiftUI TabView).
export function tabBar(active = "Nearby") {
  const tabs = [
    ["Nearby", "map-trifold"],
    ["Verify", "person-simple-run"],
    ["Profile", "person"],
  ];
  return `
  <div class="glass" style="position:absolute;left:22px;right:22px;bottom:24px;height:64px;border-radius:32px;display:flex;align-items:center;padding:4px;z-index:25">
    ${tabs
      .map(([label, ic]) => {
        const on = label === active;
        const c = on ? "#0a84ff" : "#1c1c1e";
        return `<div style="flex:1;height:56px;border-radius:28px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;${on ? "background:rgba(120,120,128,0.16)" : ""}">
        ${icon(ic, 26, c, on ? "fill" : "bold")}
        <div style="font:${on ? 600 : 500} 10.5px/12px Inter;color:${c};letter-spacing:0">${label}</div>
      </div>`;
      })
      .join("")}
  </div>`;
}

const mapButton = (ic, top) => `
  <div class="glass" style="position:absolute;right:16px;top:${top}px;width:48px;height:48px;border-radius:24px;display:flex;align-items:center;justify-content:center;z-index:15">
    ${icon(ic, 22, "#1d1d1f")}
  </div>`;

const mapImg = (d, name) => `<img class="map" src="${d.base}/assets/maps/${name}.png">`;
const credit = (dark) =>
  `<div style="position:absolute;right:8px;bottom:4px;font:500 7px Inter;color:${dark ? "rgba(255,255,255,.5)" : "rgba(0,0,0,.45)"};z-index:5">© OpenStreetMap</div>`;

// --- screens --------------------------------------------------------------

// Nearby: the landing tab. Fountains coloured by how recently they were checked.
export function nearby(d) {
  const v = d.maps["app-nearby"];
  const pts = [
    [38.90981, -77.02821, "fresh"], // Logan Circle
    [38.90998, -77.03762, "aging"], // Stead Park
    [38.9071, -77.0365, "fresh"], // Scott Circle
    [38.90565, -77.0322, "old"], // Thomas Circle
    [38.9016, -77.0341, "fresh"], // McPherson Square
    [38.9022, -77.0302, "aging"], // Franklin Square
    [38.9019, -77.0395, "old"], // Farragut Square
    [38.9131, -77.0386, "fresh"],
    [38.9141, -77.0346, "old"],
    [38.9158, -77.0318, "fresh"],
    [38.9118, -77.0291, "aging"],
    [38.9047, -77.0264, "retired"],
    [38.9083, -77.0336, "fresh"],
    [38.9113, -77.0419, "aging"],
  ];
  const me = project(v, 38.9089, -77.0353);
  return `<div class="ios">
    ${mapImg(d, "app-nearby")}
    <svg class="overlay" viewBox="0 0 440 956">
      ${pts
        .map(([la, lo, f]) => {
          const [x, y] = project(v, la, lo);
          return marker(x, y, FRESH[f]);
        })
        .join("")}
      ${userDot(...me)}
    </svg>
    ${statusBar()}
    <div class="glass" style="position:absolute;top:66px;left:50%;transform:translateX(-50%);border-radius:999px;padding:12px 20px;font:700 16px/21px Inter;color:#1877a3;z-index:15;white-space:nowrap">Search This Area</div>
    ${mapButton("crosshair-simple", 128)}
    ${mapButton("plus", 186)}
    ${tabBar("Nearby")}
    ${credit()}
    ${homeBar()}
  </div>`;
}

// Planner: picks made, the loop drawn, ready to start.
export function planner(d, { stopCount = null } = {}) {
  const v = d.maps["app-plan"];
  const stops = d.run.stops;
  const line = pathD(v, d.run.trace);
  const start = project(v, ...d.run.trace[0]);
  return `<div class="ios" style="background:#f4f6f8">
    ${mapImg(d, "app-plan")}
    <svg class="overlay" viewBox="0 0 440 956">
      <path d="${line}" fill="none" stroke="#2563eb" stroke-width="4" stroke-opacity="0.85" stroke-linejoin="round" stroke-linecap="round"/>
      ${stops
        .map((f, i) => {
          const [x, y] = project(v, f.lat, f.lon);
          return marker(x, y, "#16a34a", String(i + 1));
        })
        .join("")}
      ${marker(start[0], start[1], "#16a34a", "⚑")}
    </svg>
    ${statusBar()}
    <div style="position:absolute;left:0;right:0;bottom:0;background:#f4f6f8;border-top:1px solid rgba(12,13,10,.1);padding:20px 20px 118px;display:flex;flex-direction:column;gap:12px;z-index:10">
      <div>
        <div style="font:700 18px/24px Inter">Pick your fountains</div>
        <div style="font:400 14px/19px Inter;color:#4d5c6a;margin-top:2px">Tap a fountain to add or remove it. Touch and hold the map to route through a spot.</div>
      </div>
      <div style="border:1px solid rgba(79,175,212,.3);background:rgba(171,220,236,.1);border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <div style="font:600 16px Inter">${stopCount ?? stops.length} stops</div>
          <div style="font:700 16px Inter;color:#1877a3" class="tnum">14.61 mi</div>
        </div>
        <div style="background:#e3e8ee;border-radius:999px;min-height:48px;display:flex;align-items:center;justify-content:center;gap:8px;font:700 17px Inter">
          ${icon("arrows-counter-clockwise", 18, "#0c0d0a")} Reverse Direction</div>
      </div>
      <div style="background:#1877a3;color:#fff;border-radius:999px;min-height:48px;display:flex;align-items:center;justify-content:center;font:700 17px Inter">Start Run</div>
    </div>
    ${tabBar("Verify")}
    ${homeBar()}
  </div>`;
}

// The run's state at the moment the art shows: LeDroit Park found out of
// order, Logan Circle confirmed, heading west along P Street to Stead Park.
export const RUN_STATE = { 1: "out_of_order", 2: "confirm" };
export const RUNNER = [38.90974, -77.0313];

function runMap(d, { dim = 0 } = {}) {
  const v = d.maps["app-run"];
  const line = pathD(v, d.run.trace);
  const stops = d.run.stops;
  const me = project(v, ...RUNNER);
  return `
    ${mapImg(d, "app-run")}
    <svg class="overlay" viewBox="0 0 440 956">
      <path d="${line}" fill="none" stroke="#2563eb" stroke-width="4" stroke-opacity="0.85" stroke-linejoin="round" stroke-linecap="round"/>
      ${stops
        .map((f, i) => {
          const [x, y] = project(v, f.lat, f.lon);
          const st = RUN_STATE[f.id];
          if (st) return marker(x, y, STATUS[st].color, STATUS[st].label);
          if (f.id === 3) return marker(x, y, "#2563eb", String(i + 1), 11);
          return marker(x, y, STATUS.pending.color, String(i + 1));
        })
        .join("")}
      ${userDot(...me)}
    </svg>
    ${dim ? `<div style="position:absolute;inset:0;background:rgba(0,0,0,${dim})"></div>` : ""}`;
}

export function runScreen(d, { dist = "0.35 mi" } = {}) {
  const ghost = (ic, label, red = false) => `
    <div style="flex:1;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:999px;padding:16px;border:1px solid ${red ? "rgba(248,113,113,.4)" : "rgba(238,242,246,.25)"};${red ? "background:rgba(69,10,10,.2)" : ""}">
      ${icon(ic, 24, red ? "#f87171" : "#f7f2e8")}
      <span style="font:${red ? 700 : 600} 16px Inter;color:${red ? "#f87171" : "#eef2f6"}">${label}</span>
    </div>`;
  return `<div class="ios" style="background:#0c0d0a">
    ${runMap(d)}
    ${mapButton("crosshair-simple", 66)}
    ${mapButton("plus", 124)}
    ${statusBar()}
    <div style="position:absolute;left:0;right:0;bottom:0;background:#0c0d0a;border-top:1px solid rgba(238,242,246,.1);padding:20px 20px 34px;display:flex;flex-direction:column;gap:4px;z-index:10">
      <div style="display:flex;align-items:baseline;gap:12px">
        <div class="tnum cue-dist" style="font:700 48px/52px Inter;color:#eef2f6;letter-spacing:-0.03em">${dist}</div>
        <div style="font:600 24px Inter;color:#8fa3b3">W</div>
      </div>
      <div style="font:600 20px/26px Inter;color:#eef2f6">Stead Park</div>
      <div style="font:400 16px/21px Inter;color:#8fa3b3">Checked 5 months ago</div>
      <div style="display:flex;flex-direction:column;gap:16px;padding:16px 0 12px">
        <div style="background:#1877a3;border-radius:999px;padding:24px 20px;text-align:center;font:700 20px Inter;color:#fff">I'm Here</div>
        <div style="display:flex;gap:12px">${ghost("x-circle", "End", true)}${ghost("skip-back", "Back")}${ghost("skip-forward", "Skip")}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${icon("check-circle", 18, "#4ade80", "fill")}
        <span style="flex:1;font:400 16px Inter;color:#86efac">Saved · Logan Circle, working</span>
        <span style="font:700 16px Inter;color:#abdcec">Undo</span>
      </div>
    </div>
    ${homeBar(true)}
  </div>`;
}

// The survey sheet, as it opens on arrival at Stead Park.
export function surveySheet(d) {
  const choice = (ic, label, bg) => `
    <div style="background:${bg};border-radius:16px;padding:28px 16px;display:flex;align-items:center;justify-content:center;gap:8px">
      ${icon(ic, 28, "#fff")}<span style="font:700 20px Inter;color:#fff">${label}</span>
    </div>`;
  return `<div class="ios" style="background:#0c0d0a">
    ${runMap(d, { dim: 0.22 })}
    ${statusBar()}
    <div style="position:absolute;left:8px;right:8px;bottom:8px;top:548px;background:#fff;border-radius:42px;box-shadow:0 -10px 40px rgba(0,0,0,.25);padding:14px 26px 0;z-index:12">
      <div style="width:36px;height:5px;border-radius:3px;background:rgba(60,60,67,.3);margin:0 auto 16px"></div>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div style="font:700 22px/28px Inter;min-height:44px;display:flex;align-items:center">Stead Park</div>
        <div style="font:400 16px/21px Inter;color:#4d5c6a;margin-top:-12px">Checked 5 months ago · Working</div>
        ${choice("check-circle", "Working", "#16a34a")}
        ${choice("warning", "Problem", "#ea580c")}
      </div>
    </div>
    ${homeBar()}
  </div>`;
}

// Lock Screen with the run's Live Activity, later in the same run.
export function lockScreen(d, { wallpaper = "", ink = "#fff", activity = {} } = {}) {
  const a = {
    stop: "Montrose Park",
    dist: "0.42",
    unit: "mi",
    turn: "Turn right in 400 ft onto R Street Northwest",
    of: "Stop 8 of 9",
    ...activity,
  };
  return `<div class="ios" style="background:#0c0d0a">
    ${wallpaper}
    ${statusBar({ dark: true, time: "" })}
    <div style="position:absolute;top:84px;left:0;right:0;text-align:center;color:${ink};z-index:5">
      <div style="display:flex;justify-content:center;margin-bottom:6px">${icon("lock-simple", 22, ink, "fill")}</div>
      <div style="font:600 21px Inter;opacity:.9">Saturday, November 7</div>
      <div class="tnum" style="font:700 112px/112px Inter;letter-spacing:-0.04em;margin-top:2px;font-stretch:90%">7:42</div>
    </div>
    <div style="position:absolute;left:14px;right:14px;bottom:146px;border-radius:26px;background:#0c0d0a;padding:16px;display:flex;align-items:center;gap:12px;z-index:6;box-shadow:0 12px 40px rgba(0,0,0,.35)">
      ${icon("drop", 24, "#ccff2e", "fill")}
      <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:0">
        <div style="font:600 17px Inter;color:#eef2f6">${a.stop}</div>
        <div style="display:flex;align-items:center;gap:6px">${icon("arrow-bend-up-right", 15, "#ccff2e")}<span style="font:400 14.5px Inter;color:#eef2f6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Next: ${a.turn}</span></div>
        <div style="font:400 12px Inter;color:#8fa3b3">${a.of}</div>
      </div>
      <div style="text-align:center;min-width:56px">
        <div class="tnum" style="font:600 28px/30px ui-rounded, Inter;color:#eef2f6">${a.dist}</div>
        <div style="font:500 13px Inter;color:#8fa3b3">${a.unit}</div>
      </div>
    </div>
    <div style="position:absolute;left:46px;bottom:56px;width:50px;height:50px;border-radius:25px;background:rgba(255,255,255,.16);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:6">${icon("flashlight", 22, "#fff", "fill")}</div>
    <div style="position:absolute;right:46px;bottom:56px;width:50px;height:50px;border-radius:25px;background:rgba(255,255,255,.16);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;z-index:6">${icon("camera", 22, "#fff", "fill")}</div>
    ${homeBar(true)}
  </div>`;
}

// End of the run: the recap the run panel shows before Finish.
export const RECAP = [
  ["LeDroit Park", "out_of_order"],
  ["Logan Circle", "confirm"],
  ["Stead Park", "confirm"],
  ["Montrose Park", "confirm"],
  ["Georgetown Waterfront", "broken"],
  ["National Mall", "confirm"],
  ["Smithsonian Castle", "removed"],
  ["Lincoln Park", "confirm"],
];
export function recap(d) {
  const v = d.maps["app-plan"];
  const byName = Object.fromEntries(RECAP);
  return `<div class="ios" style="background:#0c0d0a">
    ${mapImg(d, "app-plan")}
    <svg class="overlay" viewBox="0 0 440 956">
      <path d="${pathD(v, d.run.trace)}" fill="none" stroke="#2563eb" stroke-width="4" stroke-opacity="0.85" stroke-linejoin="round" stroke-linecap="round"/>
      ${d.run.stops
        .map((f) => {
          const [x, y] = project(v, f.lat, f.lon);
          const s = STATUS[byName[f.name] ?? "skipped"];
          return marker(x, y, s.color, s.label);
        })
        .join("")}
    </svg>
    ${statusBar()}
    <div style="position:absolute;left:0;right:0;bottom:0;background:#0c0d0a;border-top:1px solid rgba(238,242,246,.1);padding:20px 20px 34px;z-index:10">
      <div style="font:700 24px/30px Inter;color:#eef2f6">Route complete</div>
      <div style="font:400 16px/21px Inter;color:#8fa3b3;margin:4px 0 14px">8 of 9 points surveyed</div>
      <div style="display:flex;flex-direction:column;gap:9px;margin-bottom:18px">
        ${RECAP.map(
          ([n, s]) => `
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:10px;height:10px;border-radius:5px;background:${s === "added" ? "#16a34a" : STATUS[s].color}"></div>
            <div style="flex:1;font:400 16px Inter;color:#eef2f6">${n}</div>
            <div style="font:400 14px Inter;color:#8fa3b3">${s === "added" ? "Added" : STATUS[s].text}</div>
          </div>`,
        ).join("")}
      </div>
      <div style="background:#1877a3;border-radius:999px;padding:24px 20px;text-align:center;font:700 20px Inter;color:#fff">Finish Run</div>
    </div>
    ${homeBar(true)}
  </div>`;
}
