import { getContext, setContext } from "svelte";

// Lets popup content (e.g. PointPopup) dismiss the map popup after an action
// without reaching for a map instance — the popup is a single controlled element
// in MapView. Replaces the React `useMapPopup` context.
const KEY = Symbol("map-popup");

type MapPopupCtx = {
  close: () => void;
  // While on, a tap on the bare map no longer closes the card: it only takes
  // focus off the field being typed in, which puts a phone's keyboard away.
  // For content holding a half-filled form — on a phone the keyboard covers
  // the card's own buttons, and tapping away is the natural way to lower it,
  // so that tap must not throw the draft away. Marker taps still move the
  // selection: that is a choice, not a dismissal.
  holdOpen: (on: boolean) => void;
};

export function setMapPopup(ctx: MapPopupCtx) {
  setContext(KEY, ctx);
}

export function getMapPopup(): MapPopupCtx {
  return getContext<MapPopupCtx>(KEY) ?? { close: () => {}, holdOpen: () => {} };
}
