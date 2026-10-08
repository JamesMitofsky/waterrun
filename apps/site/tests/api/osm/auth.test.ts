import { describe, expect, it } from "vitest";
import { GET } from "@/pages/api/osm/auth";
import { fakeCookies, routeContext } from "../../helpers/route";

const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } });

async function start(query: string, incoming: Record<string, string> = {}) {
  const jar = fakeCookies(incoming);
  const request = new Request(`https://waterrun.app/api/osm/auth${query}`);
  const res = await GET(routeContext(request, { cookies: jar.cookies, redirect }));
  return { res, ...jar };
}

describe("GET /api/osm/auth", () => {
  it("sends the user to OSM with this attempt's PKCE state, over Secure cookies", async () => {
    const { res, set } = await start("");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/oauth2/authorize?");
    expect(set.get("osm_pkce")?.options).toMatchObject({ httpOnly: true, secure: true });
    expect(set.has("osm_state")).toBe(true);
  });

  it("marks a native sign-in", async () => {
    const { set } = await start("?native=1");
    expect(set.get("osm_native")?.value).toBe("1");
  });

  it("clears what an abandoned app sign-in left behind on a web sign-in", async () => {
    const { set, deleted } = await start("", { osm_native: "1", osm_return: "/old" });
    expect(set.has("osm_native")).toBe(false);
    expect(deleted.has("osm_native")).toBe(true);
    expect(deleted.has("osm_return")).toBe(true);
  });

  it("remembers a same-origin return path, normalised", async () => {
    const { set } = await start(
      `?returnTo=${encodeURIComponent("/public-drinking-fountains?x=1#a")}`,
    );
    expect(set.get("osm_return")?.value).toBe("/public-drinking-fountains?x=1#a");
  });

  it.each(["/%09/evil.com", "/%0A/evil.com", "//evil.com", "/%5Cevil.com", "https%3A//evil.com"])(
    "refuses to remember %s",
    async (returnTo) => {
      const { set, deleted } = await start(`?returnTo=${returnTo}`);
      expect(set.has("osm_return")).toBe(false);
      expect(deleted.has("osm_return")).toBe(true);
    },
  );
});
