<script lang="ts">
  import MapView, { pulseVisibleAt, type MapMarker } from "@/components/MapView.svelte";
  import PointPopup, { type PointEdit } from "@/components/PointPopup.svelte";
  import type { EditAction, EditExtras, Fountain } from "@water-run/core/schemas";
  import type { StopStatus } from "@water-run/core/stores/run";
  import { editSummary, todayLocal } from "@water-run/core/editSummary";
  import { celebratePoint } from "@/lib/confetti";
  import { openingViewForViewport } from "@/lib/basemap/frames";
  import {
    DC_FOUNTAINS,
    DC_ROUTE,
    DEMO_NEXT_STOP,
    SEED_STATUSES,
    demoStopColor,
  } from "@/lib/demoRoute";
  import {
    DEMO_ARRIVALS,
    DEMO_CHECKPOINTS,
    DEMO_ROUTE_LENGTHS,
    DEMO_SEEDED_IN_ORDER,
    demoRunnerAt,
  } from "@/lib/demoRun";
  import { arrivalMs, legSchedule, lengthAt } from "@/lib/runReplay";

  // Interactive replica of the run screen for the landing hero. Every tap flows
  // through the real PointPopup, but edits only touch local state — nothing is
  // sent to OSM, queued in the outbox, or persisted anywhere.
  //
  // On load it replays the run so far: the line draws itself from the first
  // stop with the runner at its tip, slowing into each surveyed stop — which
  // flips from pending to its status as the runner reaches it — and setting
  // off again, until it halts at the next stop (`DEMO_NEXT_STOP`, at
  // `DEMO_RUN_END`) with the rest of the loop left faint as the plan. The
  // moment it stops there, that stop starts pinging, unmarked, and keeps on
  // until the visitor opens it: the run is handed over exactly where a runner
  // would reach for their phone, but the tap is left to the visitor — an
  // invitation to try the map rather than a popup already answering for them.
  // The replay is presentation only; the seeded statuses it reveals are the
  // same ones the map used to show from the first frame.
  let { class: className = "" }: { class?: string } = $props();

  // The opening view is initial-only, so pick it once at mount. Read from the
  // frame spec rather than restated here: this map dissolves out of a picture
  // rendered at exactly that centre and zoom, and two copies of either number
  // are two things to keep in step. The centre is not the route's own — the
  // spec shifts it so the route sits clear of the hero copy painted over the
  // map (see `frames.ts`).
  const { center, zoom } = openingViewForViewport("demo-run");

  /**
   * How long the replay takes to run from the first stop to `DEMO_RUN_END`.
   * Short: the hero's copy is what the visitor came for, and the stop left
   * pinging at the end is the replay's point, so the run is a prelude, not a
   * feature.
   */
  const RUN_MS = 2200;
  /**
   * Pause between the map being ready and the replay starting: a beat of
   * settled map before anything on it moves.
   */
  const HOLD_MS = 400;
  /** How long a stop's ping lasts once the runner reaches it. */
  const PULSE_MS = 550;
  /**
   * How long after the runner halts at `DEMO_NEXT_STOP` its beckon starts.
   *
   * Every surveyed stop changes colour the moment the runner reaches it and
   * pings from that moment too — but a ping's ring grows out from under the
   * dot, so it is first seen only once it has cleared the dot's white ring
   * (`pulseVisibleAt`). A beckon's first wave shows from its first frame.
   * Started on arrival it would lead every ping before it by that hidden
   * stretch; started this much later, `DEMO_NEXT_STOP` turns blue on arrival
   * like the others and its wave shows when a ping's ring would have.
   */
  const BECKON_DELAY_MS = PULSE_MS * pulseVisibleAt();

  /**
   * The replay's clock: one leg per stretch between checkpoints, each eased
   * in and out so the runner leaves a stop, gets up to pace, and slows into
   * the next (`runReplay.ts`). The time is shared out by distance, so the
   * pace is the same on every leg.
   */
  const LEGS = legSchedule(DEMO_CHECKPOINTS, RUN_MS);

  /** When, in ms after the replay starts, the runner reaches each surveyed stop. */
  const ARRIVAL_MS: Record<number, number> = Object.fromEntries(
    DEMO_SEEDED_IN_ORDER.map((id) => [id, arrivalMs(LEGS, DEMO_ARRIVALS[id]) ?? 0]),
  );

  const seededEdit = (id: number): PointEdit => ({
    status: SEED_STATUSES[id],
    summary: editSummary(SEED_STATUSES[id] as EditAction, "amenity", todayLocal()),
    syncState: "sent",
  });
  /** What the popup shows for a surveyed stop once the replay has reached it. */
  const SEEDED_EDITS: Record<number, PointEdit> = Object.fromEntries(
    DEMO_SEEDED_IN_ORDER.map((id) => [id, seededEdit(id)]),
  );

  // The replay's clock. `idle` until the map is ready and the hold has
  // passed, `running` while the line draws, `done` after — or at once, under
  // reduced motion, in which case the map opens on the end frame. The map is
  // locked (`interactive`) until `done`: a visitor who dragged or tapped
  // mid-replay would be fighting the camera and the stops still flipping.
  let phase = $state<"idle" | "running" | "done">("idle");
  let elapsed = $state(0);
  let ready = $state(false);

  $effect(() => {
    if (!ready || phase !== "idle") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      phase = "done";
      return;
    }
    // A replay in a background tab would run unseen and be over by the time
    // the visitor came back; wait for the tab instead.
    const start = () => {
      if (document.visibilityState === "hidden") {
        document.addEventListener("visibilitychange", start, { once: true });
        return;
      }
      phase = "running";
    };
    const timer = setTimeout(start, HOLD_MS);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", start);
    };
  });

  $effect(() => {
    if (phase !== "running") return;
    const startedAt = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const t = now - startedAt;
      if (t >= RUN_MS) {
        elapsed = RUN_MS;
        phase = "done";
        return;
      }
      elapsed = t;
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  });

  // The marker whose popup is open, bound to the map's own selection: a tap on
  // a marker sets it and a tap elsewhere clears it.
  let selected = $state<string | null>(null);

  // Whether the visitor has opened `DEMO_NEXT_STOP` yet. Latched in the
  // binding's setter (see the markup) the moment they do, and never unset:
  // the beckon has done its job, and one that came back after the popup was
  // closed would nag.
  let opened = $state(false);
  function select(id: string | null) {
    selected = id;
    if (id === String(DEMO_NEXT_STOP)) opened = true;
  }

  // Whether the run has come to rest at `DEMO_NEXT_STOP`, which from then
  // until the visitor marks it wears the route's blue (`demoStopColor`). A
  // boolean of its own, so what hangs off it — `markers` above all — is
  // rebuilt once when it flips rather than on every change of `phase`.
  const halted = $derived(phase === "done");

  // `DEMO_NEXT_STOP` beckons (MapView's `beckon`) from `BECKON_DELAY_MS` after
  // the runner comes to rest there — under reduced motion, after the end
  // frame the map opens on — until the visitor opens it. The loop itself is
  // CSS; the only clock here is the wait before it starts.
  let beckonDue = $state(false);
  $effect(() => {
    if (!halted) return;
    const timer = setTimeout(() => (beckonDue = true), BECKON_DELAY_MS);
    return () => clearTimeout(timer);
  });
  const beckon = $derived(beckonDue && !opened ? String(DEMO_NEXT_STOP) : null);

  // Per-frame values. Everything the map redraws every frame hangs off these
  // and *only* these — see `markers` below for what must not.
  const runElapsed = $derived(phase === "done" ? RUN_MS : phase === "idle" ? 0 : elapsed);
  const runLength = $derived(lengthAt(LEGS, runElapsed));
  const lineProgress = $derived(runLength / DEMO_ROUTE_LENGTHS.total);
  const runner = $derived(demoRunnerAt(runLength));

  // How many surveyed stops the runner has reached, in route order. A number,
  // so the derivations below it only re-run when a stop is actually reached —
  // not on every frame the line moves.
  const reachedCount = $derived(
    DEMO_SEEDED_IN_ORDER.filter((id) => DEMO_ARRIVALS[id] <= runLength).length,
  );

  // The visitor's own edits, over the replay's. Seeded state is not copied in
  // here: it is derived from how far the run has got, so a stop the runner has
  // not reached yet shows as pending however the seed data reads.
  let userEdits = $state<Record<number, PointEdit>>({});
  const visibleEdits = $derived.by<Record<number, PointEdit>>(() => {
    const revealed: Record<number, PointEdit> = {};
    for (const id of DEMO_SEEDED_IN_ORDER.slice(0, reachedCount)) revealed[id] = SEEDED_EDITS[id];
    return { ...revealed, ...userEdits };
  });

  function record(f: Fountain, action: EditAction, extras?: EditExtras) {
    userEdits = {
      ...userEdits,
      [f.id]: {
        status: action as StopStatus,
        summary: editSummary(action, "amenity", todayLocal(), extras),
        syncState: "pending",
        extras,
      },
    };
    celebratePoint();
    // Fake the offline-first outbox: "saved · sending…" flips to "sent to OSM"
    // a beat later, without any network involved.
    setTimeout(() => {
      if (userEdits[f.id]) {
        userEdits = { ...userEdits, [f.id]: { ...userEdits[f.id], syncState: "sent" } };
      }
    }, 900);
  }

  // Rebuilt only when a stop's state changes (`visibleEdits`, `halted`), never
  // per frame: a new marker set makes MapView re-upload the source and
  // re-place every label. The per-frame motion — the line, the runner, the
  // pings — travels on its own props.
  const markers = $derived<MapMarker[]>(
    DC_FOUNTAINS.map((f, i) => {
      const edit = visibleEdits[f.id];
      return {
        id: f.id,
        lat: f.lat,
        lon: f.lon,
        color: demoStopColor(f.id, edit?.status, halted),
        label: String(i + 1),
        // Where each stop would rather open. The stop the replay ends on asks
        // for beneath the marker: opened above, it would rise into the hero
        // copy over the map. A preference only — `MapView` opens the card on
        // the other side when this one cannot hold it (see `popupSide`).
        popupAnchor: f.id === DEMO_NEXT_STOP ? "top" : "bottom",
        // The label pops again the moment the stop changes colour: on getting
        // a status, and — for the stop the run halts at — on turning blue.
        popKey: edit ? 2 : halted && f.id === DEMO_NEXT_STOP ? 1 : 0,
        data: { f },
      };
    }),
  );

  // The ping each surveyed stop gives off as the runner reaches it: id → how
  // far through its ping it is. The same object whenever nothing is pinging,
  // so MapView's feature-state effect has nothing to do on those frames.
  const NO_PULSES: Record<string, number> = {};
  const pulses = $derived.by<Record<string, number>>(() => {
    if (phase !== "running") return NO_PULSES;
    let out: Record<string, number> | undefined;
    for (const id of DEMO_SEEDED_IN_ORDER) {
      const t = (elapsed - ARRIVAL_MS[id]) / PULSE_MS;
      if (t > 0 && t < 1) (out ??= {})[String(id)] = t;
    }
    return out ?? NO_PULSES;
  });
</script>

<div class="relative h-full w-full {className}">
  <MapView
    class="hero-map"
    {center}
    {zoom}
    lockToOpeningView
    interactive={phase === "done"}
    cooperativeGestures
    maxZoom={18}
    line={DC_ROUTE}
    start={DC_ROUTE[0]}
    {lineProgress}
    lineUpcoming
    {runner}
    {markers}
    {pulses}
    {beckon}
    centerOnSelect
    bind:selected={() => selected, select}
    hidePlaceLabels
    onReady={() => (ready = true)}
    {markerPopup}
  />
</div>

{#snippet markerPopup(m: MapMarker)}
  {@const f = (m.data as { f: Fountain }).f}
  <PointPopup
    fountain={f}
    loggedIn
    edit={visibleEdits[f.id]}
    busy={false}
    onAction={(action, extras) => record(f, action, extras)}
  />
{/snippet}
