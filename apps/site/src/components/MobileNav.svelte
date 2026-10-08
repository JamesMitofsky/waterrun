<script lang="ts">
  import { fade, fly, scale } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "svelte/motion";

  // Mobile-only nav. The desktop header renders its links inline; below `sm`
  // those are hidden and this hamburger takes over.
  // `currentPath` marks the row for the page the visitor is on (see Layout).
  // The glyphs are Phosphor's own paths written out — List and X in the
  // regular weight, the rows in fill, the same paths the desktop nav in Layout
  // inlines — rather than its components: each of those carries all six
  // weights, and this island ships on every page.
  let { inverted = false, currentPath = "" }: { inverted?: boolean; currentPath?: string } =
    $props();
  let open = $state(false);

  // Svelte transitions don't consult the media query on their own, so every
  // duration below goes through this — reduced motion collapses them to a cut.
  const ms = (n: number) => (prefersReducedMotion.current ? 0 : n);

  // Close on Escape and on click outside the menu.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open = false;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="relative">
  <button
    type="button"
    onclick={() => (open = !open)}
    aria-label={open ? "Close menu" : "Open menu"}
    aria-expanded={open}
    class={inverted
      ? "trigger inline-flex items-center justify-center rounded-xl p-2 text-white transition duration-200 ease-out hover:bg-white/10 active:scale-95"
      : "trigger inline-flex items-center justify-center rounded-xl p-2 text-blue transition duration-200 ease-out hover:bg-blue/5 active:scale-95"}
  >
    <!-- Both glyphs share one grid cell so they can cross-fade and counter-rotate
         through each other rather than popping in place. -->
    <span class="grid h-8 w-8 place-items-center">
      <span class="icon" class:hidden-icon={open}>
        <svg
          class="h-8 w-8"
          width="32"
          height="32"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z"
          ></path>
        </svg>
      </span>
      <span class="icon" class:hidden-icon={!open}>
        <svg
          class="h-8 w-8"
          width="32"
          height="32"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"
          ></path>
        </svg>
      </span>
    </span>
  </button>

  {#if open}
    <!-- Backdrop closes the menu on outside tap. -->
    <button
      type="button"
      aria-label="Close menu"
      tabindex="-1"
      onclick={() => (open = false)}
      transition:fade={{ duration: ms(160) }}
      class="fixed inset-0 z-40 cursor-default"
    ></button>

    <!-- Grows out of the trigger it hangs from (origin top-right), so the menu
         reads as unfolding from the button rather than appearing over it. -->
    <div
      transition:scale={{
        duration: ms(190),
        start: 0.94,
        opacity: 0,
        easing: cubicOut,
      }}
      class="font-hero absolute right-0 top-full z-50 mt-2 flex w-56 origin-top-right flex-col gap-1 rounded-xl border border-base/10 bg-surface p-2 shadow-xl"
    >
      <!-- Rows land in reading order. Only on the way in: leaving, the panel
           scales away as one piece and per-item exits would fight that. -->
      <a
        href="/"
        onclick={() => (open = false)}
        aria-current={currentPath === "/" ? "page" : undefined}
        in:fly={{ y: -6, duration: ms(220), delay: ms(50), easing: cubicOut }}
        class="row inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-lg text-light-muted transition duration-200 ease-out hover:bg-blue/5 hover:text-blue current-page:text-blue"
      >
        <svg
          class="h-5 w-5"
          width="20"
          height="20"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M224,120v96a8,8,0,0,1-8,8H160a8,8,0,0,1-8-8V164a4,4,0,0,0-4-4H108a4,4,0,0,0-4,4v52a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V120a16,16,0,0,1,4.69-11.31l80-80a16,16,0,0,1,22.62,0l80,80A16,16,0,0,1,224,120Z"
          ></path>
        </svg>
        Home
      </a>
      <a
        href="/public-drinking-fountains"
        onclick={() => (open = false)}
        aria-current={currentPath === "/public-drinking-fountains" ? "page" : undefined}
        in:fly={{ y: -6, duration: ms(220), delay: ms(95), easing: cubicOut }}
        class="row inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-lg text-light-muted transition duration-200 ease-out hover:bg-blue/5 hover:text-blue current-page:text-blue"
      >
        <svg
          class="h-5 w-5"
          width="20"
          height="20"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M228.92,49.69a8,8,0,0,0-6.86-1.45L160.93,63.52,99.58,32.84a8,8,0,0,0-5.52-.6l-64,16A8,8,0,0,0,24,56V200a8,8,0,0,0,9.94,7.76l61.13-15.28,61.35,30.68A8.15,8.15,0,0,0,160,224a8,8,0,0,0,1.94-.24l64-16A8,8,0,0,0,232,200V56A8,8,0,0,0,228.92,49.69ZM96,176a8,8,0,0,0-1.94.24L40,189.75V62.25L95.07,48.48l.93.46Zm120,17.75-55.07,13.77-.93-.46V80a8,8,0,0,0,1.94-.23L216,66.25Z"
          ></path>
        </svg>
        Map
      </a>
      <a
        href="/waitlist"
        onclick={() => (open = false)}
        aria-current={currentPath === "/waitlist" ? "page" : undefined}
        in:fly={{ y: -6, duration: ms(220), delay: ms(140), easing: cubicOut }}
        class="row inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-lg text-light-muted transition duration-200 ease-out hover:bg-blue/5 hover:text-blue current-page:text-blue"
      >
        <svg
          class="h-5 w-5"
          width="20"
          height="20"
          viewBox="0 0 256 256"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M221.8,175.94C216.25,166.38,208,139.33,208,104a80,80,0,1,0-160,0c0,35.34-8.26,62.38-13.81,71.94A16,16,0,0,0,48,200H88.81a40,40,0,0,0,78.38,0H208a16,16,0,0,0,13.8-24.06ZM128,216a24,24,0,0,1-22.62-16h45.24A24,24,0,0,1,128,216Z"
          ></path>
        </svg>
        Waitlist
      </a>
    </div>
  {/if}
</div>

<style>
  /* Both icons occupy the same grid cell; only opacity/transform differ. */
  .icon {
    grid-area: 1 / 1;
    display: inline-flex;
    transition:
      opacity 200ms cubic-bezier(0.22, 1, 0.36, 1),
      transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .hidden-icon {
    opacity: 0;
    /* Rotates the opposite way from its partner so the swap looks like one
       glyph turning into the other. */
    transform: rotate(-90deg) scale(0.7);
  }

  /* The row's icon leads the hover a hair ahead of the background fill. */
  .row :global(svg) {
    transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .row:hover :global(svg) {
    transform: translateX(2px);
  }

  @media (prefers-reduced-motion: reduce) {
    .icon,
    .row :global(svg) {
      transition: none;
    }
    .hidden-icon {
      transform: none;
    }
    .row:hover :global(svg) {
      transform: none;
    }
  }
</style>
