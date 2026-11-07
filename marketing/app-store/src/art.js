// Drawing helpers shared by the three directions.

import { project } from "./screens.js";

// Chaikin corner-cutting: turns a street-by-street trace into a hand-drawn curve.
export function smooth(pts, iterations = 2) {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i],
        [bx, by] = p[i + 1];
      out.push(
        [ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25],
        [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75],
      );
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// Catmull-Rom through hand-placed points, as an SVG path.
export function curve(pts, tension = 0.5) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[i + 2] ?? p2;
    const t = tension / 3;
    d += ` C${(p1[0] + (p2[0] - p0[0]) * t).toFixed(1)} ${(p1[1] + (p2[1] - p0[1]) * t).toFixed(1)}, ${(p2[0] - (p3[0] - p1[0]) * t).toFixed(1)} ${(p2[1] - (p3[1] - p1[1]) * t).toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

const dPath = (pts) =>
  pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");

// Offset a polyline sideways by `off` px (per-vertex averaged normals).
function offset(pts, off) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)],
      b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / len) * off, p[1] + (dx / len) * off];
  });
}

// The logo's "RUN" stroke: a bundle of thin parallel lines laid by one brush.
// Returns SVG markup (uses the #brush filter from defs()).
export function lanes(
  pts,
  {
    n = 6,
    gap = 3.2,
    width = 1.7,
    color = "#1e71bd",
    opacity = 0.95,
    seed = 1,
    filter = "brush",
    dash = null,
  } = {},
) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * gap + (rnd() - 0.5) * 0.8;
    const w = width * (0.75 + rnd() * 0.5);
    out.push(
      `<path d="${dPath(offset(pts, off))}" fill="none" stroke="${color}" stroke-width="${w.toFixed(2)}" stroke-opacity="${(opacity * (0.7 + rnd() * 0.3)).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" ${dash ? `pathLength="1" stroke-dasharray="${dash}"` : ""}/>`,
    );
  }
  return `<g filter="url(#${filter})">${out.join("")}</g>`;
}

export const routePx = (view, trace) => trace.map(([la, lo]) => project(view, la, lo));

// Filters every page defines once: paper grain, ragged brush edge, ink stamp.
export function defs() {
  return `<svg width="0" height="0" style="position:absolute">
    <filter id="brush" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="stamp" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" seed="8" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.5 1.55" result="holes"/>
      <feComposite in="SourceGraphic" in2="holes" operator="in" result="eaten"/>
      <feDisplacementMap in="eaten" in2="n" scale="1.6" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="11" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="table" tableValues="0 0.55"/></feComponentTransfer>
    </filter>
  </svg>`;
}

// A full-frame grain layer; blend it per direction.
export const grain = (opacity = 0.25, blend = "multiply") =>
  `<svg style="position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:${blend};opacity:${opacity};pointer-events:none" viewBox="0 0 440 956" preserveAspectRatio="none"><rect width="440" height="956" filter="url(#grain)"/></svg>`;

// Place a 440 x 956 screen anywhere on a frame.
export function place(
  html,
  { x = 0, y = 0, scale = 0.72, rotate = 0, radius = 50, shadow = "", outline = "", z = 2 },
) {
  return `<div style="position:absolute;left:0;top:0;width:440px;height:956px;transform-origin:0 0;transform:translate(${x}px,${y}px) rotate(${rotate}deg) scale(${scale});z-index:${z}">
    <div style="width:440px;height:956px;border-radius:${radius}px;overflow:hidden;${shadow ? `box-shadow:${shadow};` : ""}${outline}">${html}</div>
  </div>`;
}

// A plain, modern handset: black bezel, a hairline titanium edge.
export function device(
  html,
  { x = 0, y = 0, scale = 0.7, rotate = 0, edge = "#3a3d40", glow = "", z = 2 },
) {
  const b = 13;
  return `<div style="position:absolute;left:0;top:0;width:${440 + b * 2}px;height:${956 + b * 2}px;transform-origin:0 0;transform:translate(${x}px,${y}px) rotate(${rotate}deg) scale(${scale});z-index:${z}">
    <div style="width:100%;height:100%;border-radius:${62 + b}px;background:#050505;padding:${b}px;box-shadow:0 0 0 2.5px ${edge}, 0 0 0 4px #0b0b0b${glow ? `, ${glow}` : ""}">
      <div style="width:440px;height:956px;border-radius:60px;overflow:hidden;position:relative">${html}</div>
    </div>
  </div>`;
}
