import { describe, expect, it } from "vitest";
import { ASSET_ROUTE_SRC, hoistAssetCacheRoute } from "../../scripts/patch-vercel-routes";

const redirect = {
  src: "^/dc-drinking-fountains$",
  headers: { Location: "/public-drinking-fountains" },
  status: 301,
};
const filesystem = { handle: "filesystem" };
const assets = {
  src: ASSET_ROUTE_SRC,
  headers: { "cache-control": "public, max-age=31536000, immutable" },
  continue: true,
};
const api = { src: "^/api/fountains/?$", dest: "_render" };
const notFound = { src: "/.*", dest: "/404.html", status: 404 };

// The order @astrojs/vercel 11.0.10 writes: the cache header after the handle.
const asBuilt = () => ({ version: 3, routes: [redirect, filesystem, assets, api, notFound] });

describe("hoistAssetCacheRoute", () => {
  it("moves the asset cache route to just before the filesystem handle", () => {
    const config = asBuilt();
    expect(hoistAssetCacheRoute(config)).toEqual({
      version: 3,
      routes: [redirect, assets, filesystem, api, notFound],
    });
    // Pure: the adapter's object is left as it was.
    expect(config).toEqual(asBuilt());
  });

  it("leaves a config that already has it in the right phase alone", () => {
    const patched = hoistAssetCacheRoute(asBuilt());
    expect(hoistAssetCacheRoute(patched)).toBe(patched);
  });

  it("keeps other top-level fields", () => {
    const config = { ...asBuilt(), images: { sizes: [640] } };
    expect(hoistAssetCacheRoute(config).images).toEqual({ sizes: [640] });
  });

  it("throws when there is no filesystem handle", () => {
    expect(() => hoistAssetCacheRoute({ version: 3, routes: [redirect, assets, api] })).toThrow(
      /no filesystem handle/,
    );
  });

  it("throws when the asset route is missing", () => {
    expect(() => hoistAssetCacheRoute({ version: 3, routes: [redirect, filesystem, api] })).toThrow(
      /no asset route/,
    );
  });

  it("throws when there are no routes at all", () => {
    expect(() => hoistAssetCacheRoute({ version: 3 })).toThrow(/patch-vercel-routes/);
  });
});
