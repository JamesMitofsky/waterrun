<script lang="ts">
  import FlagIcon from "phosphor-svelte/lib/FlagIcon";
  import { START_FLAG } from "@/lib/basemap/routeLine";

  // The route's start flag as the live map plants it: Phosphor's flag, filled,
  // at `START_FLAG`'s size and colour. A component of its own so
  // DemoRoutePlaceholder.astro can draw it at build time: Astro types a Svelte
  // component through its `.svelte` path, and phosphor's per-icon subpath has
  // none, so imported there directly Astro reads Svelte 5's component
  // signature and takes the runtime's internals for its props.
</script>

<FlagIcon size={START_FLAG.px} weight="fill" color={START_FLAG.color} />
