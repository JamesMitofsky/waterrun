<script lang="ts">
  import { BUCKET_COLOR, BUCKET_GLYPH, BUCKET_LABEL, BUCKET_ORDER } from "@/lib/freshness";
  import type { MarkerGlyph } from "@/lib/markerGlyph";

  // Legend pills: each state's color tints its own pill, led by a copy of the
  // dot as the map draws it, mark included.
  let { class: className = "" }: { class?: string } = $props();

  const GLYPH_CHAR: Record<MarkerGlyph, string> = { x: "✕", question: "?" };
</script>

<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium {className}">
  <span class="text-muted tracking-wide uppercase">Last Checked</span>
  {#each BUCKET_ORDER as b (b)}
    {@const glyph = BUCKET_GLYPH[b]}
    <span
      class="text-base inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1"
      style="background: {BUCKET_COLOR[b]}1f"
    >
      <span
        class="inline-flex size-3.5 items-center justify-center rounded-full text-[9px] leading-none font-bold text-white"
        style="background: {BUCKET_COLOR[b]}"
        aria-hidden="true"
      >
        {glyph ? GLYPH_CHAR[glyph] : ""}
      </span>
      {BUCKET_LABEL[b]}
    </span>
  {/each}
</div>
