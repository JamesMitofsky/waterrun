import { configureCore } from "@rosm/core/configure";
import { api } from "./api";
import { kv, outboxStorage } from "./storage";
import { geolocation } from "./geolocation";

// Wire the Expo platform adapters into @rosm/core once, at app startup (from
// app/_layout). Live run tracking (tasks/runLocationTask's trackRun) and the
// haptics/notify/keepAwake/share/confetti adapters are consumed directly by the
// run hook, not through this registry.
export function configureMobilePorts(): void {
  configureCore({ api, kv, outboxStorage, geolocation });
}
