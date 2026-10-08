import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";
import { callApi } from "@water-run/core/apiCall";
import { onAuthChange } from "./authStore";

export type OsmStatus = { loggedIn: boolean; apiBase: string; live: boolean };

const STATUS_TIMEOUT_MS = 15_000;

// Mirror of the web components/OsmStatus: asks the server whether the current
// token is valid and which OSM (sandbox vs live) it targets. Only an answer
// changes it: a request that gets none (offline, timed out, a captive portal)
// keeps what was known, since being unreachable says nothing about being signed
// in. The local token is what gates signed-in actions. Asked again on sign
// in/out, when the app returns to the foreground and when the connection
// comes back, so a status missed while offline catches up.
export function useOsmStatus(): { status: OsmStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<OsmStatus | null>(null);

  const refresh = useCallback(async () => {
    const reply = await callApi<OsmStatus>("/api/osm/status", {}, STATUS_TIMEOUT_MS, "").catch(
      () => null,
    );
    if (reply?.ok) setStatus(reply.data);
  }, []);

  useEffect(() => {
    // Fetch-on-mount + re-fetch on auth change; refresh only setStates after its
    // await, so the rule's synchronous-setState concern doesn't apply.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const offAuth = onAuthChange(() => {
      refresh();
    });
    const appSub = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
    });
    const netSub = Network.addNetworkStateListener((state) => {
      if (state.isConnected) refresh();
    });
    return () => {
      offAuth();
      appSub.remove();
      netSub.remove();
    };
  }, [refresh]);

  return { status, refresh };
}
