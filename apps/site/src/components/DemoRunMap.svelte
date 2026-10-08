<script lang="ts">
  import MapView, { type MapMarker } from "@/components/MapView.svelte";
  import PointPopup, { type PointEdit } from "@/components/PointPopup.svelte";
  import type { EditAction, EditExtras, Fountain } from "@rosm/core/schemas";
  import type { StopStatus } from "@rosm/core/stores/run";
  import { editSummary, todayLocal } from "@rosm/core/editSummary";
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
    DEMO_ARRIVAL_MS,
    DEMO_LEGS,
    DEMO_ROUTE_LENGTHS,
    DEMO_RUN_TIMING,
    DEMO_SEEDED_IN_ORDER,
    demoRunnerAt,
  } from "@/lib/demoRun";
  import { runOrigin } from "@/lib/demoRunClock";
  import { lengthAt } from "@/lib/runReplay";

  // Interactive replica of the run screen for the landing hero. Every tap flows
  // through the real PointPopup, but edits only touch local state — nothing is
  // sent to OSM, queued in the outbox, or persisted anywhere.
  //
  // It replays the run so far: the line draws itself from the first stop with
  // the runner at its tip, slowing into each surveyed stop — which flips from
  // pending to its status as the runner reaches it — and setting off again,
  // until it halts at the next stop (`DEMO_NEXT_STOP`, at `DEMO_RUN_END`) with
  // the rest of the loop left faint as the plan. The moment it stops there,
  // that stop starts beckoning, unmarked, and keeps on until the visitor opens
  // it: the run is handed over exactly where a runner would reach for their
  // phone, but the tap is left to the visitor — an invitation to try the map
  // rather than a popup already answering for them.
  //
  // The replay does not start here. It starts in the map's loading frame
  // (`DemoRoutePlaceholder.astro`), as CSS, the moment the page paints — this
  // island and MapLibre can arrive seconds later — and this island joins it
  // wherever it has got to (`demoRunClock.ts`), so the frame dissolves off a
  // live map at the same point in the run. The replay is presentation only;
  // the seeded statuses it reveals are the same ones the map used to show
  // from the first frame.
  let { class: className = "" }: { class?: string } = $props();

  // The opening view is initial-only, so pick it once at mount. Read from the
  // frame spec rather than restated here: this map dissolves out of a picture
  // rendered at exactly that centre and zoom, and two copies of either number
  // are two things to keep in step. The centre is not the route's own — the
  // spec shifts it so the route sits clear of the hero copy painted over the
  // map (see `frames.ts`).
  const { center, zoom } = openingViewForViewport("demo-run");

  const { holdMs, runMs, pulseMs, beckonDelayMs } = DEMO_RUN_TIMING;
  /** When, in ms after the run sets off, `DEMO_NEXT_STOP` starts beckoning. */
  const BECKON_AT_MS = runMs + beckonDelayMs;
  /**
   * How long the clock keeps ticking, in ms after the run sets off: until the
   * last thing it times — the run's end, the last ping's end, the beckon's
   * start — is behind it.
   */
  const CLOCK_END_MS = Math.max(
    BECKON_AT_MS,
    ...DEMO_SEEDED_IN_ORDER.map((id) => DEMO_ARRIVAL_MS[id] + pulseMs),
  );
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const seededEdit = (id: number): PointEdit => ({
    status: SEED_STATUSES[id],
    summary: editSummary(SEED_STATUSES[id] as EditAction, "amenity", todayLocal()),
    syncState: "sent",
  });
  /** What the popup shows for a surveyed stop once the replay has reached it. */
  const SEEDED_EDITS: Record<number, PointEdit> = Object.fromEntries(
    DEMO_SEEDED_IN_ORDER.map((id) => [id, seededEdit(id)]),
  );

  // The replay's clock. `origin` is when it started, as a `performance.now()`
  // time; `elapsed` is how far the run is past setting off, negative through
  // the opening hold. The phase follows from it: `idle` until the run sets
  // off, `running` while the line draws, `done` after — or at once, under
  // reduced motion, in which case the map opens on the end frame. The map is
  // locked (`interactive`) until `done`: a visitor who dragged or tapped
  // mid-replay would be fighting the camera and the stops still flipping.
  let origin = $state<number | null>(null);
  let elapsed = $state(reducedMotion ? CLOCK_END_MS : -holdMs);
  const phase = $derived(elapsed >= runMs ? "done" : elapsed > 0 ? "running" : "idle");

  let root = $state<HTMLDivElement>();
  // Whether there is a replay in the loading frame to follow: `undefined`
  // while that is still being asked, `false` for none — no frame, or one
  // already retired — in which case the clock starts here instead.
  let followingFrame = $state<boolean | undefined>(undefined);
  let ready = $state(false);

  $effect(() => {
    const el = root;
    if (!el || reducedMotion) return;
    let current = true;
    void runOrigin(el).then((startedAt) => {
      if (!current) return;
      followingFrame = startedAt !== null;
      if (startedAt !== null) origin = startedAt;
    });
    return () => {
      current = false;
    };
  });

  // No frame to follow: the clock starts once the map is ready and the tab is
  // visible — a replay in a background tab would run unseen and be over by
  // the time the visitor came back.
  $effect(() => {
    if (followingFrame !== false || !ready || origin !== null) return;
    const start = () => {
      if (document.visibilityState === "hidden") {
        document.addEventListener("visibilitychange", start, { once: true });
        return;
      }
      origin = performance.now();
    };
    start();
    return () => document.removeEventListener("visibilitychange", start);
  });

  $effect(() => {
    const from = origin;
    if (from === null) return;
    let raf = requestAnimationFrame(function tick(now) {
      elapsed = Math.min(now - from - holdMs, CLOCK_END_MS);
      if (elapsed < CLOCK_END_MS) raf = requestAnimationFrame(tick);
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
  // rebuilt once when it flips rather than on every frame of the clock.
  const halted = $derived(phase === "done");

  // `DEMO_NEXT_STOP` beckons (MapView's `beckon`) from `beckonDelayMs` after
  // the runner comes to rest there — under reduced motion, from the end frame
  // the map opens on — until the visitor opens it. The loop itself is CSS.
  const beckon = $derived(elapsed >= BECKON_AT_MS && !opened ? String(DEMO_NEXT_STOP) : null);
  // When the beckon's loop began. The loading frame starts the same loop on
  // the same clock, so a live beckon mounted after it joins that loop in step
  // rather than starting a loop of its own.
  const beckonSince = $derived(origin === null ? undefined : origin + holdMs + BECKON_AT_MS);

  // Per-frame values. Everything the map redraws every frame hangs off these
  // and *only* these — see `markers` below for what must not.
  const runElapsed = $derived(Math.max(0, Math.min(runMs, elapsed)));
  const runLength = $derived(lengthAt(DEMO_LEGS, runElapsed));
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
  // far through its ping it is. Timed off the clock alone, not the phase, so
  // a ping that runs past the end of the run is not cut short — the loading
  // frame's own pings are not. The same object whenever nothing is pinging,
  // so MapView's feature-state effect has nothing to do on those frames.
  const NO_PULSES: Record<string, number> = {};
  const pulses = $derived.by<Record<string, number>>(() => {
    let out: Record<string, number> | undefined;
    for (const id of DEMO_SEEDED_IN_ORDER) {
      const t = (elapsed - DEMO_ARRIVAL_MS[id]) / pulseMs;
      if (t > 0 && t < 1) (out ??= {})[String(id)] = t;
    }
    return out ?? NO_PULSES;
  });
</script>

<div bind:this={root} class="relative h-full w-full {className}">
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
    {beckonSince}
    popInOnLoad={false}
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
