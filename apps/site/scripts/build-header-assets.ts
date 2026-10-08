/**
 * Derives what the site header inlines, once, at build-author time:
 *
 *   pnpm --filter @water-run/site header:assets
 *
 * - `src/assets/logo-144.png`: the brand mark at 3x its 48px render, from
 *   `public/icons/logo.png` (the full-size master the OG card also uses).
 *   Layout.astro imports it with Vite's `?inline` and sets it as a data URI.
 * - `src/assets/hero-handwriting-mask.generated.ts`: the pixel size of
 *   `src/assets/hero-handwriting-mask.webp`, for the headline box's
 *   `aspect-ratio`. Importing the WebP itself for its metadata makes the
 *   image pipeline emit a copy of it that nothing requests.
 *
 * The two masks are hand-authored and committed as-is, not derived here:
 *
 * - `src/assets/nav-active-mask.webp`: the nav's "current page" chalk
 *   splotch. `globals.css` applies it with `mask-image` and paints the blue
 *   back in with `background-color`.
 * - `src/assets/hero-handwriting-mask.webp`: the index page's handwritten
 *   headline. `index.astro` inlines it into the `<h1>` and fills it with a
 *   colour token.
 *
 * Both are alpha masks: opaque where the artwork is ink, transparent
 * elsewhere, partial in between. Each was one flat colour over a textured
 * alpha, so the alpha was the only information, and the painted originals were
 * retired once the masks replaced them. Re-crop or repaint the WebP directly,
 * then re-run this script so the recorded size follows.
 *
 * They must stay *alpha* masks, not the luminance masks (white ink on black,
 * `mask-mode: luminance`) they started as. WebKit turns the luminance flag off
 * whenever a mask's pattern tile exceeds 512 x 512 device pixels on iOS
 * (2048 x 2048 on desktop) — see webkit.org/b/282530 — which a full-width
 * headline on a 3x phone always is, so iOS painted the `<h1>` as a solid blue
 * rectangle while every desktop browser looked right. Alpha is the default
 * masking mode everywhere and goes nowhere near that code path. Exporting one
 * of these as opaque grayscale again would reinstate the bug silently, so
 * `assertAlphaMask` below fails the build instead.
 *
 * Why inline, and why this small: the header is on every page, and every page
 * is a fresh document (no client router), so each navigation paints from
 * scratch. An image the page has to *request* — even one the browser has
 * cached, since files under `public/` ship with `max-age=0, must-revalidate`
 * and are re-checked on every load — lands a beat after first paint and pops
 * in. A data URI arrives inside the HTML or CSS that references it, so it is
 * on screen in the same frame as the text beside it. That is only affordable
 * if the bytes stay small, which is what the format choices below are for.
 *
 * Why a mask beats a picture for the two blue images: one file serves every
 * breakpoint, and the colour becomes a CSS token rather than baked pixels (the
 * headline: ~27 KB at 1280px, against 31–277 KB for the five responsive WebPs
 * the image pipeline used to emit). Lossy grain is fine: chalk grain and ink
 * edges are noise, and banding in a mask reads as more chalk or more ink.
 * Sizes to keep to when re-exporting: the splotch is stretched
 * (`mask-size: 100% 100%`) over a nav item of roughly 130 x 36 CSS px, so 320
 * wide covers a 2x display with headroom; the headline renders at most 36rem
 * (576 CSS px) wide, so 1280 is over 2x and still generous at 3x. Quality 70
 * is plenty for either — and export the alpha lossy too (`alphaQuality: 70`):
 * WebP keeps an alpha channel lossless by default, which more than doubles
 * these files for grain no one can see.
 *
 * All emitted files are committed.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import sharp from "sharp";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asset = (name: string) => resolve(siteRoot, "src/assets", name);
const relative = (file: string) => file.replace(siteRoot + "/", "");

/**
 * Logo: rendered at 48 CSS px, so 144 is 3x — crisp on any phone. Flat
 * artwork with few colours, which is why it goes out as a palette PNG: as a
 * WebP the same pixels are three to four times the bytes, lossless or not.
 * 64 entries is above the mark's actual colour count; the quantiser only
 * uses what it needs.
 */
const LOGO_WIDTH = 144;
const LOGO_COLORS = 64;

async function buildLogo() {
  const outFile = asset("logo-144.png");
  const out = await sharp(resolve(siteRoot, "public/icons/logo.png"))
    .resize({ width: LOGO_WIDTH })
    .png({ palette: true, colors: LOGO_COLORS, compressionLevel: 9 })
    .toFile(outFile);
  console.log(
    `wrote ${relative(outFile)} — ${out.width}x${out.height}, ${(out.size / 1024).toFixed(1)} KB`,
  );
}

/**
 * Guards the one property of these files that no reviewer can see: the ink has
 * to live in the alpha channel. A luminance re-export (opaque, white on black)
 * still *looks* like a mask in a preview and still passes every check the CSS
 * makes, but it masks nothing on iOS — see the note at the top of this file.
 * An opaque file would mask nothing anywhere, so this is a cheap total check
 * rather than a heuristic.
 */
async function assertAlphaMask(name: string) {
  const file = asset(name);
  const { hasAlpha } = await sharp(file).metadata();
  if (!hasAlpha) {
    throw new Error(
      `${relative(file)} has no alpha channel. The masks carry their ink in ` +
        `alpha, not luminance; re-export it with transparency (see the note at ` +
        `the top of this script).`,
    );
  }
}

/** Records the hero mask's pixel size so the `<h1>` box can reserve its aspect ratio. */
async function writeHeroMaskSize() {
  const maskFile = asset("hero-handwriting-mask.webp");
  const { width, height } = await sharp(maskFile).metadata();
  if (!width || !height) {
    throw new Error(`could not read the size of ${relative(maskFile)}`);
  }
  const outFile = asset("hero-handwriting-mask.generated.ts");
  const module = `// Generated by scripts/build-header-assets.ts — do not edit.
/** Pixel size of hero-handwriting-mask.webp, for the headline box's aspect ratio. */
export const HERO_MASK_SIZE = { width: ${width}, height: ${height} } as const;
`;
  // Formatted on the way out: the emitted file is committed, so an unformatted
  // emit shows up as a dirty tree on whoever runs the next unrelated format.
  const prettierOptions = await resolveConfig(outFile);
  writeFileSync(outFile, await format(module, { ...prettierOptions, filepath: outFile }));
  console.log(`wrote ${relative(outFile)} — ${width}x${height}`);
}

void Promise.all([
  buildLogo(),
  writeHeroMaskSize(),
  assertAlphaMask("hero-handwriting-mask.webp"),
  assertAlphaMask("nav-active-mask.webp"),
]).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
