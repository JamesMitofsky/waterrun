/**
 * Derives every square brand icon, for the site and the mobile app, from one
 * master, at build-author time:
 *
 *   pnpm --filter @water-run/site brand:icons
 *
 * The master is `public/icons/logo.png`: the hand-lettered "water RUN"
 * wordmark on transparency, 1024 x 1024 with the ink running edge to edge. It
 * is also what the OG card and the header logo (`build-header-assets.ts`) are
 * cut from, so after repainting it, run both scripts.
 *
 * Every icon is the wordmark scaled down and centred on a flat tile of
 * `iconBackground` from `@water-run/core/appConfig.json` — the same token the
 * mobile splash screen uses as its background, so the launch screen reads as
 * the home-screen icon opening up.
 *
 * Why one script for both apps: the two used to be exported separately and
 * drifted (the app icon sat the wordmark at ~80% of the tile, the site at
 * 84%). Keeping the scale table below as the only place a size is decided
 * means the App Store icon and the favicon cannot disagree again.
 *
 * All emitted files are committed.
 */
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { iconBackground } = require("@water-run/core/appConfig.json") as {
  iconBackground: string;
};

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mobileRoot = resolve(siteRoot, "../mobile");
const master = resolve(siteRoot, "public/icons/logo.png");
const relative = (file: string) => file.replace(resolve(siteRoot, "..") + "/", "apps/");

/**
 * `scale` is the wordmark's width as a fraction of the tile.
 *
 * - 0.84 is the standard margin: enough cream around the lettering that iOS's
 *   rounded-corner mask and Android launchers' squircles never clip the ink.
 * - The 32px favicon runs the wordmark larger (0.90): at that size the margin
 *   costs more legibility than it buys breathing room.
 * - The maskable icon keeps the lettering inside the spec's safe zone (a
 *   centred circle 80% of the tile across), since launchers may crop to it.
 */
const ICONS: { out: string; size: number; scale: number }[] = [
  { out: resolve(siteRoot, "public/icons/icon-32.png"), size: 32, scale: 0.9 },
  { out: resolve(siteRoot, "public/icons/apple-touch-icon.png"), size: 180, scale: 0.84 },
  { out: resolve(siteRoot, "public/icons/icon-192.png"), size: 192, scale: 0.84 },
  { out: resolve(siteRoot, "public/icons/icon-512.png"), size: 512, scale: 0.84 },
  { out: resolve(siteRoot, "public/icons/maskable-512.png"), size: 512, scale: 0.58 },
  // Expo's source for every iOS/Android launcher size; App Store wants 1024.
  { out: resolve(mobileRoot, "assets/icon.png"), size: 1024, scale: 0.84 },
];

/**
 * Opaque, palette PNG. Opaque because App Store Connect rejects an app icon
 * with an alpha channel, and the tile is solid anyway. Palette because the
 * artwork is one blue over one cream: 256 entries hold the chalk grain at a
 * fraction of the bytes of truecolour.
 */
async function buildIcon({ out, size, scale }: (typeof ICONS)[number]) {
  const inner = Math.round(size * scale);
  const wordmark = await sharp(master)
    .resize({
      width: inner,
      height: inner,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer();
  const info = await sharp({
    create: { width: size, height: size, channels: 3, background: iconBackground },
  })
    .composite([{ input: wordmark, gravity: "center" }])
    .png({ palette: true, compressionLevel: 9 })
    .toFile(out);
  console.log(
    `wrote ${relative(out)} — ${info.width}x${info.height}, ${(info.size / 1024).toFixed(1)} KB`,
  );
}

/**
 * The splash image is the bare wordmark: `app.config.ts` lays it over an
 * `iconBackground` fill itself, at a fixed point width. Copied byte for byte
 * so the app ships the master's full resolution.
 */
function buildSplash() {
  const out = resolve(mobileRoot, "assets/splash-icon.png");
  copyFileSync(master, out);
  console.log(`wrote ${relative(out)} — copy of ${relative(master)}`);
}

async function assertMaster() {
  const { width, height, hasAlpha } = await sharp(master).metadata();
  // The 1024 app icon draws the wordmark ~860px wide; a smaller master would
  // be upscaled and the chalk texture would go soft.
  if (!width || width < 1024 || width !== height || !hasAlpha) {
    throw new Error(
      `${relative(master)} must be a square, transparent PNG at least 1024px ` +
        `wide (got ${width}x${height}, alpha: ${hasAlpha}).`,
    );
  }
}

void assertMaster()
  .then(() => Promise.all([...ICONS.map(buildIcon), buildSplash()]))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
