import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { GET } from "@/pages/api/osm/callback";
import { SCHEME } from "@/lib/appConfig";
import { json } from "../../helpers/upstream";
import { fakeCookies, routeContext } from "../../helpers/route";

const transient = { osm_pkce: "verifier", osm_state: "s1" };

async function callback(cookies: Record<string, string>, query = "?code=c1&state=s1") {
  const jar = fakeCookies(cookies);
  const request = new Request(`https://waterrun.app/api/osm/callback${query}`);
  const res = await GET(routeContext(request, { cookies: jar.cookies }));
  return { res, ...jar };
}

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("GET /api/osm/callback", () => {
  it("hands a native sign-in's token to the app through its configured scheme", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "tok" }));
    const { res } = await callback({ ...transient, osm_native: "1" });
    expect(res.headers.get("Location")).toBe(`${SCHEME}://osm-callback?token=tok`);
  });

  it("reports a native failure through the same scheme", async () => {
    const { res } = await callback({ ...transient, osm_native: "1" }, "?code=c1&state=wrong");
    expect(res.headers.get("Location")).toMatch(new RegExp(`^${SCHEME}://osm-callback\\?error=`));
  });

  it("sets the web cookie and returns to where sign-in started", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "tok" }));
    const { res, set } = await callback({ ...transient, osm_return: "/public-drinking-fountains" });
    expect(res.headers.get("Location")).toBe(
      "https://waterrun.app/public-drinking-fountains?osm=ok",
    );
    expect(set.get("osm_token")).toMatchObject({
      value: "tok",
      options: { httpOnly: true, secure: true },
    });
  });

  it("never follows a stored return path off this origin", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "tok" }));
    const { res } = await callback({ ...transient, osm_return: "/\t/evil.com" });
    expect(res.headers.get("Location")).toBe("https://waterrun.app/?osm=ok");
  });
});
