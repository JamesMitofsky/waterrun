import cfg from "../appConfig.json";

// How Water Run identifies itself to the services it calls (OSM API, Overpass,
// BRouter, tile hosts). Their usage policies ask for an app-specific User-Agent
// with a way to reach the operator; generic library agents ("node", "okhttp")
// are the first thing they throttle. A product token can't contain spaces, so
// "Water Run" becomes "WaterRun". Server-side only: browsers forbid setting it.
export const USER_AGENT = `${cfg.appName.replace(/\s+/g, "")}/1.0 (+https://waterrun.app)`;
