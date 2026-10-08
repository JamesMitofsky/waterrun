<script lang="ts">
  import Wrench from "phosphor-svelte/lib/Wrench";
  import DogIcon from "@/components/icons/DogIcon.svelte";
  import type { Fountain } from "@water-run/core/schemas";
  import { isDogWater, isOutOfService } from "@water-run/core/fountainFilters";
  import { checkedAgoLabel } from "@water-run/core/checkDate";

  // Read-only popup: name, last-checked date, status flags. No edit controls —
  // this view is purely for finding water nearby.
  let { f }: { f: Fountain } = $props();

  // Snapshot the clock once — the "checked ago" label doesn't need to tick live.
  const now = Date.now();
</script>

<div class="flex w-52 flex-col gap-1 text-neutral-800">
  <div class="leading-tight font-semibold">{checkedAgoLabel(f.tags, now)}</div>
  {#if isDogWater(f.tags)}
    <div class="mt-1 flex items-center gap-1 text-xs font-medium text-violet-700">
      <DogIcon size={14} /> Dog water — not for humans
    </div>
  {/if}
  {#if isOutOfService(f.tags)}
    <div class="mt-1 flex items-center gap-1 text-xs font-medium text-amber-700">
      <Wrench size={14} /> Out of order
    </div>
  {/if}
</div>
