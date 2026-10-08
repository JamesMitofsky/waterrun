<script lang="ts">
  import type { Attachment } from "svelte/attachments";

  // A call to tap one point on a map: soft waves let out from under its dot on
  // a double beat — two close together, then a rest — for as long as it is
  // mounted. Drawn in CSS over the map rather than on its canvas, so the loop
  // costs no repaint.
  //
  // Shared by the live map (`MapView`'s `beckon`) and the hero's loading frame
  // (`DemoRoutePlaceholder.astro`), which renders it at build time and starts
  // it before the live map exists. Mount it centred on the point: it draws
  // from its own origin.
  let {
    color,
    dotR,
    reachPx,
    delayMs = 0,
    since,
  }: {
    /** The waves' colour. */
    color: string;
    /** Radius of the dot the waves come out from, its white ring included, in px. */
    dotR: number;
    /** How far past the dot a wave travels before it has faded out, in px. */
    reachPx: number;
    /** How long after it is first styled the loop starts, in ms. */
    delayMs?: number;
    /**
     * A `performance.now()` time the loop is to be in step with, as if it had
     * started then — for a beckon mounted after one elsewhere already began,
     * which must carry on that loop rather than start its own. Applied to the
     * running animations themselves, so the waves land on the same beat to the
     * frame.
     */
    since?: number;
  } = $props();

  const waveR = $derived(dotR + reachPx);

  /**
   * How many frames to wait for the waves' animations to exist. A beckon
   * mounted inside a map marker can be created before the marker is attached
   * to the document, and an element outside it has no animations to align.
   */
  const ALIGN_FRAMES = 30;

  // Puts both waves, `::before` and `::after`, on `at`'s clock. Each keeps its
  // own delay, so one start time on both keeps the 200ms between them.
  function inStepWith(at: number | undefined): Attachment<HTMLElement> {
    return (el) => {
      if (at === undefined || typeof el.getAnimations !== "function") return;
      let raf = 0;
      let frames = 0;
      const align = () => {
        const animations = el.isConnected ? el.getAnimations({ subtree: true }) : [];
        if (!animations.length) {
          // None under reduced motion, ever: the wave is still.
          if (frames++ < ALIGN_FRAMES) raf = requestAnimationFrame(align);
          return;
        }
        for (const animation of animations) animation.startTime = at;
      };
      align();
      return () => cancelAnimationFrame(raf);
    };
  }
</script>

<span
  class="beckon"
  style:--beckon-color={color}
  style:--beckon-dot-r="{dotR}px"
  style:--beckon-wave-r="{waveR}px"
  style:--beckon-from={dotR / waveR}
  style:--beckon-delay="{delayMs}ms"
  aria-hidden="true"
>
  <span class="beckon-wave" {@attach inStepWith(since)}></span>
</span>

<style>
  /* Soft waves let out from under the dot on a double beat — dun dun, rest,
     dun dun — every 2.08s. The two waves of a beat start 200ms apart; each
     takes 1.8s to travel out and fade, and the next beat lands 80ms after the
     second has gone.

     - One colour. On the hero it is the route's blue, which is what marks the
       stop as the run's next; a second one adds noise, not meaning.
     - A fill, not a stroke. The wave grows by `transform: scale()`, which
       scales a border or shadow along with the box — a stroked ring swells
       into a thick, blurred band on the way out. A fill has no thickness to
       swell. It is densest at its leading edge, so it reads as a wave moving
       outward rather than a disc inflating.
     - Masked clear of the dot. The wave is laid over the map and would tint
       the dot and its label. The mask is on the unscaled `.beckon-wave` box,
       so the hole stays at the dot's edge while the fill grows through it:
       each wave is born hidden under the dot and emerges from it.
     - Short (`reachPx`), so it ends before the nearest neighbour.

     The wave grows about 2.4x, far enough that interpolating `scale()`
     directly would front-load the growth by its own accord. So the scale is
     stepped geometrically, `from^(1 - p)`, off a progress `--beckon-p` that
     the animation drives: geometry in the `transform`, timing in the curve on
     `--beckon-p`, and with the growth even to the eye the curve alone decides
     how the wave moves. It is an attack, on purpose: each wave leaps clear of
     the dot in its first few hundred ms, then drifts out as it fades. A curve
     starting at rest would leave the first wave barely past the dot when the
     second is born 200ms later, and the pair would read as one thick wave
     instead of two beats. The fade holds each wave full through its leap, so
     both are seen leaving before they thin out. */
  @property --beckon-p {
    syntax: "<number>";
    inherits: false;
    initial-value: 0;
  }
  .beckon {
    position: absolute;
    left: 50%;
    top: 50%;
    pointer-events: none;
  }
  .beckon-wave {
    position: absolute;
    inset: calc(-1 * var(--beckon-wave-r));
    mask-image: radial-gradient(
      circle closest-side,
      transparent calc(var(--beckon-dot-r) - 0.5px),
      #000 calc(var(--beckon-dot-r) + 0.5px)
    );
  }
  /* The two waves of a beat: `::before` on the beat, `::after` 200ms behind
     it. A delay offsets only the start, so across iterations of the same
     length the pair keeps its spacing for as long as the loop runs. Until
     its delay is up each wave sits at its base opacity, 0. */
  .beckon-wave::before,
  .beckon-wave::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: radial-gradient(
      circle closest-side,
      color-mix(in srgb, var(--beckon-color) 6%, transparent) 50%,
      color-mix(in srgb, var(--beckon-color) 28%, transparent) 92%,
      color-mix(in srgb, var(--beckon-color) 40%, transparent) calc(100% - 1px),
      transparent
    );
    transform: scale(pow(var(--beckon-from), 1 - var(--beckon-p)));
    opacity: 0;
    animation:
      beckon-wave-grow 2080ms infinite,
      beckon-wave-fade 2080ms infinite;
    animation-delay: var(--beckon-delay);
  }
  .beckon-wave::after {
    animation-delay: calc(var(--beckon-delay) + 200ms);
  }
  /* Both run 2.08s — the 200ms between the waves, a wave's 1.8s trip, and an
     80ms rest — with the trip in the first 86.54%, held gone for the rest;
     the fade holds full for the first 400ms (19.23%). Two animations,
     not one, so growth and fade each keep a curve of their own. */
  @keyframes beckon-wave-grow {
    0% {
      --beckon-p: 0;
      animation-timing-function: cubic-bezier(0.15, 0.6, 0.3, 1);
    }
    86.54%,
    100% {
      --beckon-p: 1;
    }
  }
  @keyframes beckon-wave-fade {
    0%,
    19.23% {
      opacity: 1;
      animation-timing-function: linear;
    }
    86.54%,
    100% {
      opacity: 0;
    }
  }
  /* Still, one wave is held at its full reach, faint, so the point stands out
     from the others without moving. The second stays at its base opacity. */
  @media (prefers-reduced-motion: reduce) {
    .beckon-wave::before,
    .beckon-wave::after {
      animation: none;
      --beckon-p: 1;
    }
    .beckon-wave::before {
      opacity: 0.6;
    }
  }
</style>
