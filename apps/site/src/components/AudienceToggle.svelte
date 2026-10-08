<script lang="ts">
  import UserIcon from "phosphor-svelte/lib/UserIcon";
  import type { Audience } from "@water-run/core/schemas";
  import DogIcon from "@/components/icons/DogIcon.svelte";
  import BothAudienceIcon from "@/components/icons/BothAudienceIcon.svelte";

  const OPTIONS = [
    { key: "humans", label: "Humans", Icon: UserIcon },
    { key: "both", label: "Both", Icon: BothAudienceIcon },
    { key: "dogs", label: "Dogs", Icon: DogIcon },
  ] as const;

  let {
    value,
    onChange,
    label = "Intended for",
  }: { value: Audience; onChange: (a: Audience) => void; label?: string } = $props();
</script>

<div class="flex flex-col gap-1">
  <span class="text-xs font-medium tracking-wide text-neutral-500 uppercase">{label}</span>
  <div class="flex gap-1 rounded-md bg-neutral-100 p-0.5">
    {#each OPTIONS as { key, label: optLabel, Icon } (key)}
      <button
        type="button"
        onclick={() => onChange(key)}
        class="flex flex-1 items-center justify-center gap-1 rounded py-1 text-xs font-medium capitalize transition {value ===
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
