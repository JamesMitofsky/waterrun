// @ts-check
import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import vercel from "@astrojs/vercel";
import tailwindcss from "@tailwindcss/vite";

// Server output (API endpoints under src/pages/api). Static pages are still
// prerendered by default; only routes/endpoints that opt out run on-demand.
export default defineConfig({
  // The canonical origin. Anything that must be an absolute URL — the social
  // card, sitemaps, canonical links — resolves against `Astro.site`, so a
  // preview deployment still points crawlers at the production image rather
  // than at a URL that only exists for the life of the preview.
  site: "https://waterrun.app",
  output: "server",
  adapter: vercel(),
  integrations: [svelte()],
  // Prefetch every same-origin link once it scrolls into view, so the next
  // page is already cached by the time it is tapped. `viewport` rather than
  // the default `hover` because most visits are on phones, where hover never
  // fires and the fetch would otherwise start only on tap. Safe here: no
  // anchor points at an /api route, so nothing with side effects is fetched.
  // Opt a single link out with `data-astro-prefetch="false"`.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "viewport",
  },
  // The fountain map was published as a DC page before it became the site's
  // one map page. Permanent, so anything holding the old URL — search results,
  // shared links — is told to update it rather than follow it every time.
  redirects: {
    "/dc-drinking-fountains": { status: 301, destination: "/public-drinking-fountains" },
  },
  vite: {
    plugins: [tailwindcss()],
    // Without a stated floor the release minifier reads a prefixed property
    // and its standard twin as one declaration and keeps only the last —
    // which silently dropped `backdrop-filter` from the map frames' frosted
    // glass in every build, so Firefox rendered them unblurred. Given targets
    // it keeps both, and adds prefixes the floor needs but the source omits.
    // The floor is the oldest browsers the site supports for its visitors;
    // Safari 15 (iOS 15) is among them and still needs -webkit-backdrop-filter.
    build: {
      cssTarget: ["chrome110", "firefox115", "safari15", "edge110"],
      // The header nav's current-page mask must ride inside the stylesheet as
      // a data URI, whatever its byte size: as a separate request it paints a
      // beat after the text it sits behind (see scripts/build-header-assets.ts).
      // Everything else keeps Vite's default 4 KB threshold.
      assetsInlineLimit: (filePath, content) =>
        filePath.endsWith("nav-active-mask.webp") || content.length < 4096,
    },
  },
});
