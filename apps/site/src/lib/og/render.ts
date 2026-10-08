import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { OG_SIZE } from "./card";

/*
 * The shared Open Graph card: the Water Run wordmark over a blurred street map.
 *
 * No type is set on it, which is why there is no Satori/resvg pass any more —
 * the card is three bitmaps stacked, which is sharp's whole job. Composition,
 * bottom to top: the map, blurred; a white scrim that mutes it; the wordmark.
 *
 * The map is `basemap.webp` beside this file, a still of the site's own
 * basemap over Washington, committed rather than fetched: a card built at
 * deploy time cannot depend on a tile host answering, and this one is blurred
 * past the point where a fresher map would look any different. It is stored at
 * 1400px wide for a 1200px card, wider than the card's 1.9:1 so `cover` crops
 * the top and bottom rather than pushing in on the middle — the framing the
 * card wants is the wide one, not the close one.
 *
 * Basemap © OpenStreetMap contributors, via CARTO. The card carries no
 * attribution itself: it is a blurred field with no readable label, and the
 * maps on the site credit OSM through MapLibre's own AttributionControl.
 */

const LOGO_WIDTH = 520;
/** Blur radius, in pixels of the finished card. Enough that no road reads as a road. */
const BLUR = 6;
/** White veil over the map, so the wordmark has something quiet to sit on. */
const SCRIM_OPACITY = 0.18;
/** Lifted a little: the veil takes colour out of the map, and this puts it back. */
const SATURATION = 1.2;

const siteRoot = process.cwd();

// Read once at module load (build time) and reused.
const logo = readFileSync(join(siteRoot, "public", "icons", "logo.png"));
const basemap = readFileSync(join(siteRoot, "src", "lib", "og", "basemap.webp"));

const scrim = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_SIZE.width}" height="${OG_SIZE.height}">` +
    `<rect width="100%" height="100%" fill="#ffffff" opacity="${SCRIM_OPACITY}"/>` +
    `</svg>`,
);

export async function renderOgImage(): Promise<Buffer> {
  const background = await sharp(basemap)
    .resize(OG_SIZE.width, OG_SIZE.height, { fit: "cover" })
    .blur(BLUR)
    .modulate({ saturation: SATURATION })
    .toBuffer();

  const wordmark = await sharp(logo).resize({ width: LOGO_WIDTH }).toBuffer();

  // JPEG, not PNG: the card is a blurred photograph of a map, the worst case
  // for PNG (570 KB as RGBA) and an easy one for JPEG (~70 KB), and share
  // previews (WhatsApp is the usual example) drop images much past 300 KB.
  // The card is opaque, so JPEG's lack of alpha costs nothing; `flatten`
  // settles anything transparent on white rather than the encoder's black.
  return sharp(background)
    .composite([
      { input: scrim, top: 0, left: 0 },
      { input: wordmark, gravity: "centre" },
    ])
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}
