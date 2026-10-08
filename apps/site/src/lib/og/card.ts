/**
 * What the social card is, in the two places that must agree about it: the
 * route that renders the JPEG (`pages/opengraph-image.jpg.ts`) and the layout
 * that describes it (`og:image:alt` in `Layout.astro`). Kept apart from
 * `render.ts`: that module reads the logo and the basemap thumbnail at import
 * and pulls in sharp, which the layout has no business paying for.
 *
 * The card carries no copy — it is the wordmark over a blurred map — so the
 * alt text is the only place the picture is put into words.
 */
export const OG_SIZE = { width: 1200, height: 630 };

export const OG_ALT =
  "Water Run — the wordmark over a softly blurred street map of Washington, DC.";
