<script lang="ts">
  import type { Snippet } from "svelte";
  import SnowflakeIcon from "phosphor-svelte/lib/SnowflakeIcon";
  import type { Audience, Dispenser, EditExtras } from "@rosm/core/schemas";
  import { NOTE_MAX, hasQuickTag, normalizeNote, toggleQuickTag } from "@rosm/core/note";
  import { audienceFromTags } from "@/lib/audience";
  import { dispenserFromTags } from "@/lib/dispenser";
  import AudienceToggle from "@/components/AudienceToggle.svelte";
  import DispenserToggle from "@/components/DispenserToggle.svelte";

  const QUICK_TAGS = [
    "Not draining",
    "Low water pressure",
    "One fountain not running",
    "Bottle filler not running",
  ];

  let {
    tags,
    busy,
    submitLabel,
    submitIcon,
    submitClassName = "bg-green-600 hover:bg-green-700",
    onSubmit,
    isRemoved = false,
    isOutOfOrder = false,
    isBroken = false,
  }: {
    tags: Record<string, string>;
    busy: boolean;
    submitLabel: string;
    submitIcon?: Snippet;
    submitClassName?: string;
    onSubmit: (extras?: EditExtras) => void;
    isRemoved?: boolean;
    isOutOfOrder?: boolean;
    isBroken?: boolean;
  } = $props();

  // Derive initial values from tags (tags identity is stable per popup).
  let seasonal = $state(tags.seasonal === "yes");
  let audience = $state<Audience>(audienceFromTags(tags));
  let dispenser = $state<Dispenser>(dispenserFromTags(tags));
  let note = $state(tags.note ?? tags.description ?? "");
  let error = $state<string | null>(null);

  // Each pill's next note, or null when adding it would overflow NOTE_MAX.
  let quickTags = $derived(
    QUICK_TAGS.map((tag) => ({
      tag,
      active: hasQuickTag(note, tag),
      next: toggleQuickTag(note, tag),
    })),
  );

  function buildExtras(cleaned: string): EditExtras | undefined {
    if (isRemoved) {
      return cleaned ? { note: cleaned } : undefined;
    }
    const extras: EditExtras = { audience, dispenser };
    if (seasonal && !isOutOfOrder) extras.seasonal = true;
    if (cleaned) extras.note = cleaned;
    return Object.keys(extras).length ? extras : undefined;
  }

  // Refuse a note the server's EditExtras schema would reject. The note is the
  // only field here it can reject, and a core test pins NOTE_MAX to its limit.
  function submit() {
    const cleaned = normalizeNote(note);
    if (cleaned.length > NOTE_MAX) {
      error = `Shorten the note to ${NOTE_MAX} characters (it has ${cleaned.length}).`;
      return;
    }
    onSubmit(buildExtras(cleaned));
  }
</script>

<div class="flex flex-col gap-2.5">
  {#if isRemoved}
    <div class="rounded border border-red-200 bg-red-50 p-2 text-xs font-medium text-red-700">
      Confirm marking this fountain as removed.
    </div>
  {:else}
    <AudienceToggle value={audience} onChange={(a) => (audience = a)} />
    <DispenserToggle value={dispenser} onChange={(d) => (dispenser = d)} />
    {#if !isOutOfOrder}
      <label
        class="flex cursor-pointer items-center justify-between rounded-lg border p-2.5 transition {seasonal
          ? 'border-sky-500 bg-sky-50/70'
          : 'border-neutral-200 bg-neutral-50 hover:bg-neutral-100'}"
      >
        <div class="flex items-center gap-2.5">
          <input
            type="checkbox"
            bind:checked={seasonal}
            class="size-4 cursor-pointer rounded border-neutral-300 accent-sky-600"
          />
          <div class="flex flex-col">
            <span class="text-xs font-bold text-neutral-900">Seasonal fountain</span>
            <span class="text-[11px] font-medium text-neutral-500">Runs only part of the year</span>
          </div>
        </div>
        <SnowflakeIcon
          size={18}
          class={seasonal ? "text-sky-600" : "text-neutral-400"}
          weight={seasonal ? "fill" : "regular"}
        />
      </label>
    {/if}
  {/if}

  {#if isBroken}
    <div class="flex flex-col gap-1.5 pt-1">
      <span class="text-[11px] font-bold tracking-wider text-neutral-600 uppercase">
        What's wrong with the fountain?
      </span>
      <div class="flex flex-wrap gap-1">
        {#each quickTags as { tag, active, next } (tag)}
          <button
            type="button"
            disabled={next === null}
            aria-pressed={active}
            onclick={() => {
              if (next === null) return;
              note = next;
              error = null;
            }}
            class="rounded border px-2 py-1 text-[11px] font-medium transition disabled:opacity-40 {active
              ? 'border-amber-600 bg-amber-500 text-white'
              : 'border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100'}"
          >
            {tag}
          </button>
        {/each}
      </div>
      {#if quickTags.some((q) => q.next === null)}
        <span class="text-[11px] font-medium text-neutral-500">
          Note is full. Shorten it to add more.
        </span>
      {/if}
    </div>
  {/if}

  <textarea
    bind:value={note}
    oninput={() => (error = null)}
    placeholder={isBroken ? "Describe what's wrong…" : "Add a public note…"}
    rows={2}
    maxlength={NOTE_MAX}
    class="resize-none rounded-md border border-neutral-300 px-2 py-1.5 text-xs text-neutral-800 placeholder:text-neutral-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
  ></textarea>
  {#if error}
    <span class="text-[11px] font-semibold text-red-600">{error}</span>
  {/if}
  <button
    disabled={busy}
    onclick={submit}
    class="flex items-center justify-center gap-1.5 rounded-md py-2 text-xs font-semibold text-white shadow-sm transition disabled:opacity-50 {submitClassName}"
  >
    {@render submitIcon?.()}
    {submitLabel}
  </button>
</div>
