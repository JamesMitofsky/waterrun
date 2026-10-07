/** What `visibleTimeout` needs of a document: whether it is shown, and word when that changes. */
export type VisibilitySource = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

/**
 * `setTimeout`, counting only the time the page is shown. Returns a cancel
 * function.
 *
 * For a deadline on work the browser only does while the page is visible.
 * MapLibre draws — and so fires `load` — from requestAnimationFrame, which
 * does not run in a hidden tab, while a plain timer there keeps counting: a
 * map opened in a background tab would be declared dead before it had been
 * given a single frame to load in. Here the clock stops while the page is
 * hidden and picks up where it left off once it is shown again.
 */
export function visibleTimeout(
  ms: number,
  cb: () => void,
  doc: VisibilitySource = document,
): () => void {
  let remaining = ms;
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (timer !== undefined || doc.visibilityState !== "visible") return;
    armedAt = performance.now();
    timer = setTimeout(fire, remaining);
  };
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (performance.now() - armedAt));
  };
  const onChange = () => (doc.visibilityState === "visible" ? arm() : pause());
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    doc.removeEventListener("visibilitychange", onChange);
  };
  function fire() {
    // Once only: a later visibility change must not start the clock again.
    cancel();
    cb();
  }

  doc.addEventListener("visibilitychange", onChange);
  arm();
  return cancel;
}
