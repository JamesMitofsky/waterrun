<script module lang="ts">
  export type LoadingStep = { text: string; ms: number };

  // Generic play-by-play of what an Overpass round-trip is doing, so the wait
  // feels earned. Durations are deliberately uneven (~5s each). The last line
  // holds until the fetch resolves. Callers can override with location copy.
  export const DEFAULT_LOADING_STEPS: LoadingStep[] = [
    { text: "Opening a socket to OpenStreetMap servers…", ms: 5000 },
    { text: "Scanning nearby drinking-water nodes…", ms: 5000 },
    { text: "Reading check_date tags to grade recency…", ms: 5000 },
  ];

  // How far the bar crawls between step boundaries; most forward motion is the
  // jump each step makes the instant its text appears.
  const CRAWL_GAIN = 20;

  // Percent-complete curve derived from the step list so any copy works.
  function makeProgressAt(steps: LoadingStep[]): (ms: number) => number {
    const starts = steps.reduce<number[]>((acc, _s, i) => {
      acc.push(i === 0 ? 0 : acc[i - 1] + steps[i - 1].ms);
      return acc;
    }, []);
    const base = steps.map((_s, i) => 10 + (i / steps.length) * 84);
    return (ms: number): number => {
      let i = 0;
      while (i < starts.length - 1 && ms >= starts[i + 1]) i += 1;
      const b = base[i];
      const elapsedInStep = ms - starts[i];
      const isLast = i === steps.length - 1;
      if (isLast) return Math.min(99, b + (99 - b) * (1 - Math.exp(-elapsedInStep / 22000)));
      const dur = steps[i].ms;
      const t = Math.min(1, elapsedInStep / dur);
      const inOut = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const eased = 0.4 * t + 0.6 * inOut;
      return b + CRAWL_GAIN * eased;
    };
  }
</script>

<script lang="ts">
  import { fade, fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "svelte/motion";

  // Self-narrating loader for a fountain fetch. `overlay` frosts a map plate
  // behind glass — the map stays faintly visible through it, never fully hidden;
  // `inline` slots in where a control lived.
  let {
    active,
    done = false,
    failed = false,
    steps = DEFAULT_LOADING_STEPS,
    variant = "inline",
  }: {
    active: boolean;
    done?: boolean;
    failed?: boolean;
    steps?: LoadingStep[];
    variant?: "overlay" | "inline";
  } = $props();

  let stepIdx = $state(0);
  let show = $state(active);

  // Progress is driven straight into the DOM (fill width + % text) from the RAF
  // loop rather than through reactive state — a per-frame reactive width stalls
  // on iOS Safari. Plain (non-reactive) refs so writes don't trigger renders.
  let fillEl: HTMLDivElement;
  let pctEl: HTMLSpanElement;
  let progress = 0;
  function applyProgress(p: number) {
    progress = p;
    // Deliberate direct DOM writes: a per-frame reactive width stalls on iOS
    // Safari, so the bar is driven straight into these nodes (they hold no other
    // Svelte-managed content, so the runtime can't get out of sync).
    if (fillEl) fillEl.style.width = `${p}%`;
    // The figure only when it changes, which is a few times a second, not
    // every frame: each write replaces the text node and dirties its layout.
    const pct = `${Math.round(p)}%`;
    // eslint-disable-next-line svelte/no-dom-manipulating
    if (pctEl && pctEl.textContent !== pct) pctEl.textContent = pct;
  }

  // Every transition's duration goes through this — reduced motion collapses
  // them to a cut, as in MobileNav.
  const ms = (n: number) => (prefersReducedMotion.current ? 0 : n);

  const progressAt = $derived(makeProgressAt(steps));
  const step = $derived(steps[stepIdx] ?? steps[steps.length - 1]);

  // Enter and reset whenever a fetch starts.
  $effect(() => {
    if (!active) return;
    show = true;
    stepIdx = 0;
    applyProgress(0);
  });

  // No graceful finish requested: hide as soon as the fetch stops.
  $effect(() => {
    if (!active && !done) show = false;
  });

  // Walk the play-by-play at an uneven cadence, holding the final line.
  $effect(() => {
    if (!active) return;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (i >= steps.length - 1) return;
      timer = setTimeout(() => {
        i += 1;
        stepIdx = i;
        tick();
      }, steps[i].ms);
    };
    tick();
    return () => clearTimeout(timer);
  });

  // Drive the bar off wall-clock elapsed time so its surge-and-creep curve is
  // independent of the text rotation.
  $effect(() => {
    if (!active) return;
    const fn = progressAt;
    const start = performance.now();
    let raf = requestAnimationFrame(function loop(t) {
      applyProgress(fn(t - start));
      raf = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(raf);
  });

  // Fetch resolved: rush the bar to 100%, then fade the overlay out.
  $effect(() => {
    if (!done) return;
    const from = progress;
    const start = performance.now();
    const DUR = 550;
    let raf = requestAnimationFrame(function run(t) {
      const k = Math.min(1, (t - start) / DUR);
      const eased = 1 - Math.pow(1 - k, 3); // easeOutCubic
      applyProgress(from + (100 - from) * eased);
      if (k < 1) raf = requestAnimationFrame(run);
    });
    const hide = setTimeout(() => (show = false), DUR + 260);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hide);
    };
  });

  // A failed fetch should reveal the error card, not sit under the loader.
  $effect(() => {
    if (failed) show = false;
  });
</script>

{#snippet body()}
  <div class="w-full max-w-md">
    <div class="mb-2 flex justify-end">
      <span bind:this={pctEl} class="text-muted font-mono text-xs tabular-nums">0%</span>
    </div>
    <div class="bg-base/10 h-1.5 w-full overflow-hidden rounded-full">
      <div bind:this={fillEl} class="bg-link h-full rounded-full" style="width:0"></div>
    </div>
  </div>
  <div class="relative flex min-h-[4rem] w-full max-w-md items-start justify-center">
    {#key stepIdx}
      <p
        in:fly={{ y: 10, duration: ms(320), delay: ms(90), easing: cubicOut }}
        out:fly={{ y: -10, duration: ms(260), easing: cubicOut }}
        class="text-muted absolute inset-x-0 top-0 font-mono text-sm leading-relaxed tracking-tight"
      >
        {step.text}
      </p>
    {/key}
  </div>
{/snippet}

{#if show && !failed}
  {#if variant === "overlay"}
    <div
      transition:fade={{ duration: ms(550) }}
      class="bg-surface/30 absolute inset-0 z-[650] flex flex-col items-center justify-center gap-8 px-8 text-center backdrop-blur-md"
    >
      {@render body()}
    </div>
  {:else}
    <div
      transition:fade={{ duration: ms(300) }}
      class="flex flex-col items-center gap-4 py-1 text-center"
    >
      {@render body()}
    </div>
  {/if}
{/if}
