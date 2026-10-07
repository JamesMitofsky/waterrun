<script module lang="ts">
  import type { EditExtras } from "@rosm/core/schemas";
  import type { StopStatus } from "@rosm/core/stores/run";
  import type { SyncState } from "@rosm/core/stores/outbox";

  // Local feedback for a point already updated in this session. The edit is saved
  // on-device first; changesetUrl only exists once OSM accepts it.
  export type PointEdit = {
    status: StopStatus;
    summary: string;
    syncState: SyncState;
    changesetUrl?: string;
    extras?: EditExtras;
  };
</script>

<script lang="ts">
  import CheckCircle from "phosphor-svelte/lib/CheckCircle";
  import MinusCircle from "phosphor-svelte/lib/MinusCircle";
  import PlusCircle from "phosphor-svelte/lib/PlusCircle";
  import Snowflake from "phosphor-svelte/lib/Snowflake";
  import Trash from "phosphor-svelte/lib/Trash";
  import Warning from "phosphor-svelte/lib/Warning";
  import Wrench from "phosphor-svelte/lib/Wrench";
  import DogIcon from "@/components/icons/DogIcon.svelte";
  import { getMapPopup } from "@/lib/mapPopup";
  import type { Fountain, EditAction } from "@rosm/core/schemas";
  import { checkedAgoLabel } from "@rosm/core/checkDate";
  import PointDetailsForm from "@/components/PointDetailsForm.svelte";
  import OsmSignInLink from "@/components/OsmSignInLink.svelte";
  import SyncBadge from "@/components/SyncBadge.svelte";

  type DetailAction = "confirm" | "broken" | "out_of_order" | "removed";

  const STATUS_LABEL: Record<string, string> = {
    confirm: "Confirmed working",
    broken: "Marked working but broken",
    out_of_order: "Marked out of order",
    removed: "Marked removed",
  };

  const DETAIL_STEP: Record<DetailAction, { submitLabel: string; submitClassName: string }> = {
    confirm: { submitLabel: "Confirm working", submitClassName: "bg-green-600 hover:bg-green-700" },
    broken: {
      submitLabel: "Mark working but broken",
      submitClassName: "bg-amber-500 hover:bg-amber-600",
    },
    out_of_order: {
      submitLabel: "Mark out of order",
      submitClassName: "bg-orange-600 hover:bg-orange-700",
    },
    removed: { submitLabel: "Confirm removed", submitClassName: "bg-red-600 hover:bg-red-700" },
  };

  // True when OSM tags already flag this point as dog water / not human-potable.
  function isDogWater(tags: Record<string, string>): boolean {
    return tags.drinking_water === "no";
  }

  let {
    fountain,
    loggedIn,
    edit,
    busy,
    onAction,
    inRoute,
    onToggleRoute,
  }: {
    fountain: Fountain;
    loggedIn: boolean;
    edit?: PointEdit;
    busy: boolean;
    onAction: (action: EditAction, extras?: EditExtras) => void;
    inRoute?: boolean;
    onToggleRoute?: () => void;
  } = $props();

  const { close, holdOpen } = getMapPopup();
  let detailFor = $state<DetailAction | null>(null);
  // The detail step is a draft — a status picked, maybe a note half typed — so
  // a tap on the map only lowers the keyboard while it is open (see
  // `holdOpen`). Cancel and submit leave it as before.
  $effect(() => {
    holdOpen(detailFor !== null);
    return () => holdOpen(false);
  });
  // Snapshot the clock once — the "checked ago" label doesn't need to tick live.
  const now = Date.now();
</script>

{#snippet submitIcon()}
  {#if detailFor === "confirm"}<CheckCircle size={16} weight="fill" />
  {:else if detailFor === "broken"}<Wrench size={16} />
  {:else if detailFor === "out_of_order"}<Warning size={16} />
  {:else if detailFor === "removed"}<Trash size={16} />
  {/if}
{/snippet}

<div class="flex w-60 flex-col gap-2.5 text-neutral-800">
  {#if !detailFor}
    <div>
      <div class="text-xs font-medium tracking-wide text-neutral-500">
        {checkedAgoLabel(fountain.tags, now, "long")}
      </div>
      {#if isDogWater(fountain.tags)}
        <div class="mt-1 flex items-center gap-1 text-xs font-medium text-violet-700">
          <DogIcon size={14} /> Dog water — not for humans
        </div>
      {/if}
    </div>
  {/if}

  {#if edit}
    <div class="flex flex-col gap-1 rounded bg-neutral-50 p-2 text-xs text-neutral-700">
      <div class="font-medium text-neutral-800">{STATUS_LABEL[edit.status] ?? "Updated"}</div>
      <div>{edit.summary}</div>
      {#if edit.extras?.seasonal}
        <div class="flex items-center gap-1 text-sky-700"><Snowflake size={14} /> Seasonal</div>
      {/if}
      {#if edit.extras?.note}
        <div class="text-neutral-600 italic">“{edit.extras.note}”</div>
      {/if}
      <SyncBadge state={edit.syncState} />
      {#if edit.changesetUrl}
        <a
          href={edit.changesetUrl}
          target="_blank"
          rel="noreferrer"
          class="font-medium underline underline-offset-2"
        >
          view on OSM
        </a>
      {/if}
    </div>
  {:else}
    {#if onToggleRoute}
      <button
        onclick={() => {
          onToggleRoute?.();
          close();
        }}
        class="flex items-center justify-center gap-1.5 rounded border py-1.5 text-xs font-semibold transition {inRoute
          ? 'border-red-400 text-red-600 hover:bg-red-50'
          : 'border-green-500 text-green-700 hover:bg-green-50'}"
      >
        {#if inRoute}<MinusCircle size={14} /> Remove from route
        {:else}<PlusCircle size={14} /> Add to route{/if}
      </button>
    {/if}

    <div class={onToggleRoute ? "border-t border-neutral-200 pt-2" : ""}>
      {#if !loggedIn}
        <OsmSignInLink
          class="block rounded bg-blue-600 py-1.5 text-center text-xs font-semibold text-white"
        >
          Sign in to OSM to update
        </OsmSignInLink>
      {:else if !detailFor}
        <div class="grid auto-rows-fr grid-cols-2 gap-3">
          <button
            disabled={busy}
            onclick={() => (detailFor = "out_of_order")}
            class="flex flex-col items-center justify-center gap-1.5 rounded-md border border-orange-300 px-1 py-3.5 text-center text-xs font-semibold text-orange-700 transition hover:bg-orange-50 disabled:opacity-50"
          >
            <Warning size={26} weight="bold" />
            <span>Out of order</span>
          </button>
          <button
            disabled={busy}
            onclick={() => (detailFor = "confirm")}
            class="flex flex-col items-center justify-center gap-1.5 rounded-md bg-green-600 px-1 py-3.5 text-center text-xs font-semibold text-white shadow-sm transition hover:bg-green-700 disabled:opacity-50"
          >
            <CheckCircle size={26} weight="fill" />
            <span>Working</span>
          </button>
          <button
            disabled={busy}
            onclick={() => (detailFor = "removed")}
            class="flex flex-col items-center justify-center gap-1.5 rounded-md border border-red-300 px-1 py-3.5 text-center text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
          >
            <Trash size={26} weight="bold" />
            <span>Removed</span>
          </button>
          <button
            disabled={busy}
            onclick={() => (detailFor = "broken")}
            class="flex flex-col items-center justify-center gap-1.5 rounded-md bg-amber-500 px-1 py-3.5 text-center text-xs font-semibold text-white shadow-sm transition hover:bg-amber-600 disabled:opacity-50"
          >
            <Wrench size={26} weight="bold" />
            <span>Working but broken</span>
          </button>
        </div>
      {:else}
        <div class="flex flex-col gap-2">
          <PointDetailsForm
            tags={fountain.tags}
            {busy}
            submitLabel={DETAIL_STEP[detailFor].submitLabel}
            {submitIcon}
            submitClassName={DETAIL_STEP[detailFor].submitClassName}
            isRemoved={detailFor === "removed"}
            isOutOfOrder={detailFor === "out_of_order"}
            isBroken={detailFor === "broken"}
            onSubmit={(extras) => {
              onAction(detailFor as EditAction, extras);
              detailFor = null;
            }}
          />
          <button
            onclick={() => (detailFor = null)}
            class="rounded border border-neutral-200 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100"
          >
            Cancel
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
