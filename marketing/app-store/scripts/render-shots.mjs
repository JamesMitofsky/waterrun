// Renders the three screenshot sets at App Store Connect's 6.9" iPhone size,
// 1320 x 2868 px (the 440 x 956 pt frames, @3x). Each direction is one page of
// six frames side by side, so anything drawn across frames (Night Shift's line,
// Public Works' slabs) lines up when the store shows them in a row.
//
//   node scripts/render-shots.mjs                 # all three
//   node scripts/render-shots.mjs night-shift     # one
//
// Writes export/screenshots/<direction>/NN-<name>.jpg and a contact sheet. JPEG
// at quality 93 with full-resolution colour (4:4:4): App Store Connect takes
// JPEG or PNG without alpha, and the paper/concrete grain makes lossless PNGs
// three to four times the size for no visible gain.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, root, serve } from "./lib.mjs";

export const SETS = {
  "field-notes": ["nearby", "plan", "run", "survey", "lock-screen", "public-map"],
  "night-shift": ["run", "nearby", "plan", "survey", "lock-screen", "public-map"],
  "public-works": ["nearby", "plan", "run", "survey", "lock-screen", "public-map"],
};

const only = process.argv.slice(2);
const { server, url } = await serve();
const browser = await chromium.launch();
for (const [set, names] of Object.entries(SETS)) {
  if (only.length && !only.includes(set)) continue;
  const out = resolve(root, "export/screenshots", set);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const page = await browser.newPage({
    viewport: { width: 2640, height: 956 },
    deviceScaleFactor: 3,
  });
  page.on("pageerror", (e) => console.error(`[${set}]`, e.message));
  await page.goto(`${url}/src/${set}.html`);
  await page.waitForFunction(() => window.READY, null, { timeout: 120_000 });
  const files = [];
  for (const [i, name] of names.entries()) {
    const png = resolve(out, `${String(i + 1).padStart(2, "0")}-${name}.png`);
    const file = png.replace(/\.png$/, ".jpg");
    await page.screenshot({ path: png, clip: { x: i * 440, y: 0, width: 440, height: 956 } });
    execFileSync("convert", [
      png,
      "-background",
      "white",
      "-alpha",
      "remove",
      "-alpha",
      "off",
      "-strip",
      "-sampling-factor",
      "4:4:4",
      "-quality",
      "93",
      file,
    ]);
    rmSync(png);
    files.push(file);
  }
  execFileSync("convert", [
    ...files,
    "-resize",
    "440x",
    "-bordercolor",
    "white",
    "-border",
    "0",
    "+append",
    resolve(root, "export/screenshots", `${set}-contact.jpg`),
  ]);
  await page.close();
  console.log(`${set}: ${files.length} screenshots`);
}
await browser.close();
server.close();
