<script lang="ts">
  import {
    BUCKET_COLOR,
    BUCKET_LABEL,
    BUCKET_ORDER,
    RETIRED_COLOR,
    RETIRED_LABEL,
  } from "@/lib/freshness";

  // Legend pills: each freshness state's color fills its own pill, followed by
  // the gray that marks a recently confirmed out-of-service point.
  let { class: className = "" }: { class?: string } = $props();
</script>

<div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium {className}">
  <span class="text-muted tracking-wide uppercase">Last Checked</span>
  {#each BUCKET_ORDER as b (b)}
    <span class="text-base rounded-full px-2 py-0.5" style="background: {BUCKET_COLOR[b]}1f">
      {BUCKET_LABEL[b]}
    </span>
  {/each}
  <span class="text-base rounded-full px-2 py-0.5" style="background: {RETIRED_COLOR}33">
    {RETIRED_LABEL}
  </span>
</div>
