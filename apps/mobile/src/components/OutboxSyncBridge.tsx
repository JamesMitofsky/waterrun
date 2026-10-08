import { useEffect } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";
import { useOutbox } from "@rosm/core/stores/outbox";
import { getToken, onAuthChange } from "../auth/authStore";

// App-wide outbox driver: hydrate the queue on launch, then push queued edits out
// whenever whatever held them back may have cleared — connectivity returns, the
// app comes back to the foreground (timers don't run while it is suspended), or
// the user signs in. Each of those flushes is forced, skipping the backoff of
// edits that failed earlier. Renders nothing.
export function OutboxSyncBridge() {
  useEffect(() => {
    const flushNow = () =>
      useOutbox
        .getState()
        .flush({ force: true })
        .catch((e) => console.warn("[outbox] flush failed", e));

    useOutbox
      .getState()
      .hydrate()
      .catch((e) => console.warn("[outbox] hydrate failed", e))
      .then(flushNow);

    const netSub = Network.addNetworkStateListener((state) => {
      if (state.isConnected) flushNow();
    });
    const appSub = AppState.addEventListener("change", (next) => {
      if (next === "active") flushNow();
    });
    // Edits that got a 401 wait for a token; signing out needs no flush.
    const offAuth = onAuthChange(() => {
      if (getToken()) flushNow();
    });

    return () => {
      netSub.remove();
      appSub.remove();
      offAuth();
    };
  }, []);

  return null;
}
