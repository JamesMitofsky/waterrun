// Locating fast: a map shown at once from the phone's last fix, then corrected
// by a fresh one.
//
// A cold GPS fix takes seconds, longer indoors or under trees, and a screen
// that waits for it shows nothing but a spinner. The OS usually still holds a
// recent fix that is close enough to center a map and search around, so both
// are asked for at once: the recent fix, if there is one, is used straight
// away, and the fresh fix follows to correct it.
import { haversine, type Pt } from "./geo";

export type LocateSource = {
  // The last fix the OS holds, when it is recent and accurate enough to show;
  // null when there isn't one (or location isn't permitted yet).
  recent: () => Promise<Pt | null>;
  // A fresh fix. May ask for permission; rejects when no fix can be had.
  current: () => Promise<Pt>;
};

export type Fix = { pos: Pt; fresh: boolean };

// Reports the recent fix (unless the fresh one beat it) and then the fresh
// one. Reports an error only when no fix came at all: with a recent fix on
// screen, a fresh one that fails isn't worth interrupting the user for.
// Returns a cancel function; nothing is reported after it is called.
export function locateFast(
  src: LocateSource,
  onFix: (fix: Fix) => void,
  onError: (e: unknown) => void,
): () => void {
  let live = true;
  let freshArrived = false;
  let reported = false;
  const recent = src.recent().catch(() => null);
  void recent.then((pos) => {
    if (!live || freshArrived || !pos) return;
    reported = true;
    onFix({ pos, fresh: false });
  });
  src.current().then(
    (pos) => {
      freshArrived = true;
      if (!live) return;
      reported = true;
      onFix({ pos, fresh: true });
    },
    // The recent fix may still be on its way: settle that first, and only
    // call it a failure if it brought nothing either.
    (e) =>
      void recent.then(() => {
        if (live && !reported) onError(e);
      }),
  );
  return () => {
    live = false;
  };
}

// Whether a fresh fix should redo the search made around a recent one. Only
// when it moved far enough to change what is found (`fraction` of the search
// radius), and only while the
// user hasn't taken the map over: a pan, a zoom or an open point means they
// are already using the results, and a new search would pull them away.
export function shouldRefineSearch(o: {
  searchedFrom: Pt;
  radiusM: number;
  fresh: Pt;
  fraction: number;
  userActed: boolean;
}): boolean {
  if (o.userActed) return false;
  return haversine(o.searchedFrom, o.fresh) > o.radiusM * o.fraction;
}
