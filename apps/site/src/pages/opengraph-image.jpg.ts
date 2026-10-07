import type { APIRoute } from "astro";
import { renderOgImage } from "@/lib/og/render";

// Static social card, rendered once at build time (the logo and the basemap
// thumbnail are read from disk here, no serverless cold-start). One card for
// the whole site: every page's `Layout` points at it (see the `og:image` note
// there).
export const prerender = true;

// No Cache-Control: a prerendered route is written out as a static file, so in
// production this Response's headers never reach the CDN, and the file gets
// the platform's static-file caching like anything in public/. (`immutable`
// would be wrong anyway, for a URL with no hash in it.) The type is for
// `astro dev`, which serves the route live.
export const GET: APIRoute = async () => {
  const jpeg = await renderOgImage();
  return new Response(new Uint8Array(jpeg), {
    headers: { "Content-Type": "image/jpeg" },
  });
};
