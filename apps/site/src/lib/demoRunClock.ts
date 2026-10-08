/**
 * The one clock the hero's replay runs on, across the hand-off from loading
 * frame to live map.
 *
 * The replay starts in the loading frame (`DemoRoutePlaceholder.astro`), as CSS
 * animations, the moment the page paints — long before the island that plays it
 * on the live map (`DemoRunMap.svelte`) has downloaded. When that island mounts
 * it does not start the replay over: it reads when the frame's replay started
 * and carries on from there, so the frame dissolves off a live map that is at
 * exactly the same point in the run.
 *
 * The start is read off the frame's own animation rather than off a timestamp
 * a script wrote down. A CSS animation starts on the frame it is first styled —
 * after any render-blocking stylesheet, which a timestamp taken by an inline
 * script would run ahead of — and its `startTime` is on the document timeline,
 * the same clock as `performance.now()` and every `requestAnimationFrame`
 * callback. Every animation the frame starts in the same style change shares
 * that start time, so the clock element's is the whole frame's.
 */

/**
 * On the placeholder's root. Set to {@link DEMO_RUN_PLAYING} — which is what
 * lets the frame's animations run — once the page is visible: a replay in a
 * background tab would play unseen and be over by the time the visitor came
 * back.
 */
export const DEMO_RUN_ATTR = "data-demo-run";
export const DEMO_RUN_PLAYING = "play";

/** On the element whose animation is the replay's clock. */
export const DEMO_RUN_CLOCK_ATTR = "data-demo-run-clock";

/**
 * When the loading frame's replay started, as a `performance.now()` time — at
 * once if it has started, or when it does if the page is still waiting to be
 * shown. `null` when there is no replay in the frame to follow: no placeholder,
 * one already retired, or a visitor who asked for reduced motion (the frame
 * shows the end of the run instead of playing it).
 *
 * `from` is any element inside the map's frame.
 */
export function runOrigin(from: Element): Promise<number | null> {
  const frame = from.closest("[data-map-frame]");
  const root = frame?.querySelector<HTMLElement>(`[${DEMO_RUN_ATTR}]`);
  const clock = root?.querySelector<HTMLElement>(`[${DEMO_RUN_CLOCK_ATTR}]`);
  if (!root || !clock || typeof clock.getAnimations !== "function") return Promise.resolve(null);
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    // Observes only while waiting (see below); disconnecting it before then is a no-op.
    const removal = new MutationObserver(() => {
      if (!clock.isConnected) finish(null);
    });
    const onStart = () => settle() || finish(null);
    const finish = (startedAt: number | null) => {
      removal.disconnect();
      clock.removeEventListener("animationstart", onStart);
      resolve(startedAt);
    };
    const settle = (): boolean => {
      const anim = clock.getAnimations()[0];
      if (!anim) return false;
      // `ready` resolves at once for an animation that is already running, and
      // on the frame it starts for one still pending — by which point its
      // start time is known. It rejects if the frame is torn down first.
      anim.ready.then(
        (a) => finish(typeof a.startTime === "number" ? a.startTime : null),
        () => finish(null),
      );
      return true;
    };
    if (settle()) return;
    // Playing but with no animation means the clock never got one (its CSS
    // failed to apply); there is nothing to wait for.
    if (root.getAttribute(DEMO_RUN_ATTR) === DEMO_RUN_PLAYING) {
      finish(null);
      return;
    }
    // Still waiting for the page to be shown. The frame may be retired first —
    // a page loaded in a background tab can have its map ready, and the
    // frame's overlay dissolved and removed, before the visitor ever looks —
    // and a clock that has left the document will never start. Then there is
    // no replay to follow, and the live map has to play its own.
    clock.addEventListener("animationstart", onStart, { once: true });
    removal.observe(frame!, { childList: true, subtree: true });
  });
}
