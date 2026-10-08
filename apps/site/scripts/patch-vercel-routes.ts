/**
 * Post-build fix-up of the Vercel adapter's routing table, run by `pnpm build`
 * right after `astro build`:
 *
 *   astro build && tsx scripts/patch-vercel-routes.ts
 *
 * The adapter means to serve everything under `/_astro/` — the fingerprinted
 * JS, CSS and fonts — as `immutable` for a year, and writes a header route
 * saying so. It writes it in the wrong place. Vercel's routing runs in
 * phases: routes before `{ "handle": "filesystem" }` apply to every request,
 * routes after it only to requests no static file answered. The adapter
 * (@astrojs/vercel 11) builds its redirects with `getTransformedRoutes({
 * rewrites: [] })`, and @vercel/routing-utils closes any rewrites list —
 * empty or not — with that filesystem handle; the asset route is appended
 * after the redirects, so it lands in the miss-only phase. Every `/_astro/`
 * file *is* a static file, so the rule never fires and the assets go out with
 * the platform default, `max-age=0, must-revalidate`: every navigation
 * re-checks every stylesheet, module and font before it can use it.
 *
 * Moving the one route to just before the filesystem handle puts it where the
 * adapter already puts its own static-header routes. If the adapter is fixed
 * upstream the patch finds the route already there and does nothing; if its
 * output changes shape it throws, so the build fails rather than shipping
 * uncached assets silently.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The adapter's long-cache route for `build.assets` (Astro's default `_astro`). */
export const ASSET_ROUTE_SRC = "^/_astro/(.*)$";

type Route = Record<string, unknown>;
export type VercelConfig = { routes?: Route[] } & Record<string, unknown>;

/**
 * The config with the `/_astro/` header route moved to just before the
 * filesystem handle. Returns the input itself when it is already there.
 */
export function hoistAssetCacheRoute<T extends VercelConfig>(config: T): T {
  const routes = config.routes ?? [];
  const filesystem = routes.findIndex((route) => route.handle === "filesystem");
  const asset = routes.findIndex((route) => route.src === ASSET_ROUTE_SRC && "headers" in route);
  if (filesystem === -1 || asset === -1) {
    throw new Error(
      `patch-vercel-routes: expected a { handle: "filesystem" } route and a ${ASSET_ROUTE_SRC} ` +
        `header route in .vercel/output/config.json, found ${filesystem === -1 ? "no filesystem handle" : "no asset route"}. ` +
        `The adapter's output has changed; check where it now puts the /_astro/ cache header.`,
    );
  }
  if (asset < filesystem) return config;

  // The asset route is after the handle, so taking it out leaves the handle's
  // index unchanged.
  const rest = routes.filter((_, i) => i !== asset);
  return {
    ...config,
    routes: [...rest.slice(0, filesystem), routes[asset], ...rest.slice(filesystem)],
  };
}

function main() {
  const file = fileURLToPath(new URL("../.vercel/output/config.json", import.meta.url));
  const config = JSON.parse(readFileSync(file, "utf8")) as VercelConfig;
  const patched = hoistAssetCacheRoute(config);
  if (patched === config) {
    console.log("patch-vercel-routes: /_astro/ cache route already precedes the filesystem handle");
    return;
  }
  // Tab-indented like the adapter's own write, so a diff of the two is the move.
  writeFileSync(file, `${JSON.stringify(patched, null, "\t")}\n`);
  console.log("patch-vercel-routes: moved the /_astro/ cache route before the filesystem handle");
}

// Run only as the build step, not when the test imports the function.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
