import { describe, expect, it } from "vitest";
import { isNativeAuthCallback, tokenKeyFor } from "../src/nativeAuth";

describe("tokenKeyFor", () => {
  it("names the entry after the API host, keeping keys SecureStore accepts", () => {
    expect(tokenKeyFor("waterrun.app")).toBe("osm_token_waterrun.app");
    expect(tokenKeyFor("192.168.1.10:4321")).toBe("osm_token_192.168.1.10_4321");
    expect(tokenKeyFor("")).toBe("osm_token");
  });
});

describe("isNativeAuthCallback", () => {
  it("recognizes the sign-in callback in each form the router may see", () => {
    expect(isNativeAuthCallback("waterrun://osm-callback?token=abc")).toBe(true);
    expect(isNativeAuthCallback("waterrun://osm-callback")).toBe(true);
    expect(isNativeAuthCallback("waterrun://osm-callback/?token=abc")).toBe(true);
    expect(isNativeAuthCallback("waterrun:///osm-callback?error=denied")).toBe(true);
    expect(isNativeAuthCallback("/osm-callback?token=abc")).toBe(true);
  });

  it("leaves every other link to the router", () => {
    expect(isNativeAuthCallback("waterrun://run")).toBe(false);
    expect(isNativeAuthCallback("/plan")).toBe(false);
    expect(isNativeAuthCallback("waterrun://osm-callbacks")).toBe(false);
    expect(isNativeAuthCallback("waterrun://plan?next=osm-callback")).toBe(false);
    expect(isNativeAuthCallback("https://waterrun.app/osm-callback")).toBe(false);
    expect(isNativeAuthCallback("exp+water-run://expo-development-client/?url=x")).toBe(false);
  });
});
