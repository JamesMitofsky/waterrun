import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadNearbyCenter, saveNearbyCenter } from "../src/nearbyView";
import { configureCore } from "../src/configure";
import { configureTestPorts } from "./helpers/ports";

const CENTER_KEY = "water-run:nearby:center";

let kv: ReturnType<typeof configureTestPorts>["kv"];
let ports: ReturnType<typeof configureTestPorts>["ports"];

beforeEach(() => {
  // Fresh in-memory kv port per test (stands in for the device kv store).
  ({ kv, ports } = configureTestPorts());
});

describe("loadNearbyCenter / saveNearbyCenter", () => {
  it("opens where the last center was saved", () => {
    saveNearbyCenter({ lat: 40.7128, lon: -74.006 });
    expect(loadNearbyCenter()).toEqual({ lat: 40.7128, lon: -74.006 });
    saveNearbyCenter({ lat: -33.8688, lon: 151.2093 });
    expect(loadNearbyCenter()).toEqual({ lat: -33.8688, lon: 151.2093 });
  });

  it("keeps only the coordinates of a fix", () => {
    const fix = { lat: 51.5, lon: -0.12, heading: 90, accuracy: 12 };
    saveNearbyCenter(fix);
    expect(JSON.parse(kv.get(CENTER_KEY)!)).toEqual({ lat: 51.5, lon: -0.12 });
  });

  it("is null before anything was saved", () => {
    expect(loadNearbyCenter()).toBeNull();
  });

  it("is null for a corrupt value", () => {
    kv.set(CENTER_KEY, '{"lat":40.7,');
    expect(loadNearbyCenter()).toBeNull();
  });

  it("is null for a value that isn't a place on the globe", () => {
    const bad = [
      '{"lat":91,"lon":0}',
      '{"lat":0,"lon":-180.5}',
      '{"lat":1e999,"lon":0}',
      '{"lat":null,"lon":0}',
      '{"lat":"40.7","lon":"-74"}',
      '{"lon":-74}',
      "[40.7,-74]",
      "40.7",
      "null",
    ];
    for (const raw of bad) {
      kv.set(CENTER_KEY, raw);
      expect(loadNearbyCenter(), raw).toBeNull();
    }
  });

  it("accepts the edges of the globe", () => {
    kv.set(CENTER_KEY, '{"lat":-90,"lon":180}');
    expect(loadNearbyCenter()).toEqual({ lat: -90, lon: 180 });
  });

  it("never throws when storage fails", () => {
    configureCore({
      ...ports,
      kv: {
        get: () => {
          throw new Error("disk I/O error");
        },
        set: () => {
          throw new Error("disk full");
        },
        remove: () => {},
      },
    });
    expect(() => saveNearbyCenter({ lat: 1, lon: 2 })).not.toThrow();
    expect(loadNearbyCenter()).toBeNull();
  });

  it("does nothing where core isn't configured", async () => {
    // A fresh copy of the modules, where configureCore was never called.
    vi.resetModules();
    const { corePorts } = await import("../src/configure");
    const fresh = await import("../src/nearbyView");
    expect(() => corePorts()).toThrow();
    expect(fresh.loadNearbyCenter()).toBeNull();
    expect(() => fresh.saveNearbyCenter({ lat: 1, lon: 2 })).not.toThrow();
  });
});
