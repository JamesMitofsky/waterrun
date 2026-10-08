import { beforeEach, describe, expect, it } from "vitest";
import { draftSaveAction } from "../src/draftSave";
import { usePlanner, type Draft } from "../src/stores/planner";
import type { Fountain } from "../src/schemas";
import { configureTestPorts } from "./helpers/ports";

let apiFetchMock: ReturnType<typeof configureTestPorts>["apiFetch"];

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const routeOk = () =>
  ok({
    coords: [
      [-77.03, 38.9],
      [-77.031, 38.901],
    ],
    distanceM: 4000,
    turns: [],
  });

const f = (id: number, lat: number, lon: number): Fountain => ({ id, lat, lon, tags: {} });
const CENTER = { lat: 38.9, lon: -77.03 };
const FOUNTAINS = [f(1, 38.901, -77.031), f(2, 38.902, -77.032), f(3, 38.903, -77.033)];

const flush = () => new Promise((r) => setTimeout(r, 0));
const initialState = usePlanner.getInitialState();
const action = () => draftSaveAction(usePlanner.getState());

beforeEach(() => {
  ({ apiFetch: apiFetchMock } = configureTestPorts());
  usePlanner.setState(initialState, true);
});

describe("draftSaveAction", () => {
  const route = { draftReady: true, resumable: null, stops: [FOUNTAINS[0]], routeStale: false };

  it("saves a route that planned", () => {
    expect(draftSaveAction(route)).toBe("save");
  });

  it("drops a waiting save before the saved draft is read, while it is on offer, or with no route", () => {
    expect(draftSaveAction({ ...route, draftReady: false })).toBe("drop");
    expect(draftSaveAction({ ...route, resumable: {} as Draft })).toBe("drop");
    expect(draftSaveAction({ ...route, stops: [] })).toBe("drop");
  });

  it("holds while the route is stale, and drops once a search has cleared it", () => {
    expect(draftSaveAction({ ...route, routeStale: true })).toBe("hold");
    expect(draftSaveAction({ ...route, routeStale: true, stops: [] })).toBe("drop");
  });

  describe("against the planner", () => {
    // A committed route through pins 1 and 3, with the draft already read.
    async function buildRoute() {
      usePlanner.setState({
        center: CENTER,
        fountains: FOUNTAINS,
        pinnedIds: [1, 3],
        draftReady: true,
      });
      apiFetchMock.mockResolvedValueOnce(routeOk());
      await usePlanner.getState().planAndRoute();
    }

    it("holds the route a removal could not re-plan, which would resume with the point back in", async () => {
      await buildRoute();
      expect(action()).toBe("save");

      apiFetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
      usePlanner.getState().removeStop(3);
      await flush();

      const s = usePlanner.getState();
      // The picks exclude 3, but the route on hand still visits it.
      expect(s.excludedIds).toContain(3);
      expect(s.stops.map((x) => x.id)).toContain(3);
      expect(action()).toBe("hold");

      // Retried and planned: the new route is the one to save.
      apiFetchMock.mockResolvedValueOnce(routeOk());
      await usePlanner.getState().retryRoute();
      expect(usePlanner.getState().stops.map((x) => x.id)).not.toContain(3);
      expect(action()).toBe("save");
    });

    it("holds while a re-plan is in flight", async () => {
      await buildRoute();
      let land!: (r: Response) => void;
      apiFetchMock.mockReturnValueOnce(new Promise<Response>((r) => (land = r)));

      usePlanner.getState().addVia(38.904, -77.034);
      expect(action()).toBe("hold");

      land(routeOk());
      await flush();
      expect(action()).toBe("save");
    });
  });
});
