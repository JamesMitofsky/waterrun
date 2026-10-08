import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { OG_SIZE } from "@/lib/og/card";
import { renderOgImage } from "@/lib/og/render";

// `render.ts` reads the logo and basemap from `process.cwd()`, which is the
// package root under `pnpm --filter @rosm/site test`, as it is under the build.
describe("renderOgImage", () => {
  it("renders an opaque JPEG at the card size, small enough for share previews", async () => {
    const card = await renderOgImage();

    // JPEG SOI marker.
    expect(card[0]).toBe(0xff);
    expect(card[1]).toBe(0xd8);
    const meta = await sharp(card).metadata();
    expect(meta.format).toBe("jpeg");
    expect({ width: meta.width, height: meta.height }).toEqual(OG_SIZE);
    expect(meta.hasAlpha).toBe(false);
    // Well under the ~300 KB past which some apps (WhatsApp) drop the preview;
    // the PNG this replaced was 570 KB.
    expect(card.length).toBeLessThan(150 * 1024);
  });
});
