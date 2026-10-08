<script lang="ts">
  import type { Dispenser } from "@water-run/core/schemas";
  import BubblerIcon from "@/components/icons/BubblerIcon.svelte";
  import BothDispenserIcon from "@/components/icons/BothDispenserIcon.svelte";
  import BottleIcon from "@/components/icons/BottleIcon.svelte";

  const OPTIONS = [
    { key: "bubbler", label: "Bubbler", Icon: BubblerIcon },
    { key: "both", label: "Both", Icon: BothDispenserIcon },
    { key: "bottle", label: "Bottle filler", Icon: BottleIcon },
  ] as const;

  let {
    value,
    onChange,
    label = "Dispenser",
  }: { value: Dispenser; onChange: (d: Dispenser) => void; label?: string } = $props();
</script>

<div class="flex flex-col gap-1">
  <span class="text-xs font-medium tracking-wide text-neutral-500 uppercase">{label}</span>
  <div class="flex gap-1 rounded-md bg-neutral-100 p-0.5">
    {#each OPTIONS as { key, label: optLabel, Icon } (key)}
      <button
        type="button"
        onclick={() => onChange(key)}
        class="flex flex-1 items-center justify-center gap-1 rounded py-1 text-xs font-medium transition {value ===
        key
          ? 'bg-white text-neutral-900 shadow-sm'
          : 'text-neutral-500 hover:text-neutral-800'}"
      >
        <Icon size={14} />
        <span>{optLabel}</span>
      </button>
    {/each}
  </div>
</div>
