/**
 * Renders the social card to a file, so it can be looked at without a build:
 *
 *   pnpm --filter @water-run/site og:preview
 *
 * The card is a build-time artefact — `pages/opengraph-image.jpg.ts` is
 * prerendered — so the two other ways to see it both come with a wait or a
 * running server: `astro build` and open `dist/client/opengraph-image.jpg`, or
 * hit `/opengraph-image.jpg` on the dev server. This is the same
 * `renderOgImage()` both of those call, pointed at a scratch file.
 *
 * Output goes to `.og-preview.jpg` at the package root (git-ignored) unless a
 * path is passed. Re-run after touching `basemap.webp`, the logo, or any of
 * the constants in `render.ts`.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderOgImage } from "../src/lib/og/render";

const DEFAULT_OUT = ".og-preview.jpg";

// `render.ts` resolves the logo and basemap from `process.cwd()`, the same as
// it does under `astro build`, so this must be run from the package root.
const out = resolve(process.cwd(), process.argv[2] ?? DEFAULT_OUT);

const jpeg = await renderOgImage();
writeFileSync(out, jpeg);

console.log(`Wrote ${out} (${(jpeg.length / 1024).toFixed(0)} KB)`);
