<script lang="ts">
  import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
  import CloudArrowUpIcon from "phosphor-svelte/lib/CloudArrowUpIcon";
  import WarningCircleIcon from "phosphor-svelte/lib/WarningCircleIcon";
  import type { SyncState } from "@rosm/core/stores/outbox";

  // Inline per-point sync badge for popups/banners.
  let { state }: { state: SyncState } = $props();
</script>

{#if state === "sent"}
  <span class="inline-flex items-center gap-1 text-green-700">
    <CheckCircleIcon size={13} /> sent to OSM
  </span>
{:else if state === "failed"}
  <span class="inline-flex items-center gap-1 text-red-600">
    <WarningCircleIcon size={13} /> send failed — will retry
  </span>
{:else}
  <span class="inline-flex items-center gap-1 text-amber-600">
    <CloudArrowUpIcon size={13} /> saved · sending…
  </span>
{/if}
