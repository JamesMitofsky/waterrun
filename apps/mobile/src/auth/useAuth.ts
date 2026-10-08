import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { getToken, loadToken, onAuthChange } from "./authStore";

// How long the splash waits on the keychain. A read normally takes
// milliseconds; one that hasn't answered by then shows the app signed out, and
// the gate still flips if the token turns up later.
const KEYCHAIN_WAIT_MS = 3000;

// Drives the router auth gate. `ready` is false until the keychain read settles
// (splash stays up); `signedIn` flips whenever the token is stored/cleared.
//
// A read that fails still makes the app ready, signed out for now, rather than
// holding the splash until the app is killed. That isn't a sign-out: iOS keeps
// the keychain locked on a background launch while the phone is locked, so the
// read is tried again each time the app comes to the foreground, until one
// succeeds or the user signs in.
export function useAuth(): { signedIn: boolean; ready: boolean } {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    let unread = true;
    const update = () => {
      if (mounted) setSignedIn(getToken() != null);
    };
    const read = () =>
      loadToken()
        .then(
          () => {
            unread = false;
          },
          (e) => console.warn("[auth] couldn't read the keychain", e),
        )
        .finally(update);

    read();
    const backstop = setTimeout(() => {
      if (mounted) setSignedIn((s) => s ?? getToken() != null);
    }, KEYCHAIN_WAIT_MS);
    const offAuth = onAuthChange(update);
    const appSub = AppState.addEventListener("change", (next) => {
      if (next === "active" && unread && getToken() == null) read();
    });

    return () => {
      mounted = false;
      clearTimeout(backstop);
      offAuth();
      appSub.remove();
    };
  }, []);

  return { signedIn: signedIn === true, ready: signedIn !== null };
}
