<script lang="ts">
  import MapView, { type MapMarker } from "@/components/MapView.svelte";
  import { BUCKET_COLOR, bucketOf } from "@/lib/freshness";
  import FountainPopup from "@/components/fountains/FountainPopup.svelte";
  import SearchProgress, { type LoadingStep } from "@/components/fountains/SearchProgress.svelte";
  import ErrorNotice from "@/components/ErrorNotice.svelte";
  import type { Fountain } from "@water-run/core/schemas";
  import { isOutOfService } from "@water-run/core/fountainFilters";
  import { fetchRegionFountains, fountainLoadErrorMessage } from "@/lib/regionFountains";
  import { haversine } from "@water-run/core/geo";

  // Live counterpart to DemoRunMap: every drinking-water point in a fixed area
  // around central DC, colored by how recently it was verified. Read-only; no
  // editing.
  let { class: className = "" }: { class?: string } = $props();

  // Hard client-side ceiling for the fountain fetch. The server gives up on
  // Overpass sooner than this and says so; this is for a connection that
  // stalls and says nothing.
  const FETCH_TIMEOUT_MS = 20_000;

  const DC_CENTER: [number, number] = [38.8972, -77.0369];
  const CENTER_PT = { lat: DC_CENTER[0], lon: DC_CENTER[1] };

  // Location-specific play-by-play for the hero fetch.
  const LOADING_STEPS: LoadingStep[] = [
    { text: "Opening a socket to OpenStreetMap servers…", ms: 5000 },
    { text: "Scanning drinking-water nodes…", ms: 5000 },
    { text: "Reading check_date tags to grade recency…", ms: 5000 },
  ];

  let fountains = $state<Fountain[]>([]);
  // A load is under way, from the request until its fountains are on the map.
  let busy = $state(false);
  // The last fetch's error, if any. Rendering is deferred (see `showErr`) so a
  // flash — from navigating away, an unmount, or a superseded load — never
  // reaches the screen.
  let err = $state<string | null>(null);
  // Snapshot of "now" captured at fetch time — keeps freshness bucketing pure.
  let nowMs = $state(0);
  // Bumped once the fountains land so MapView refits to their bounding box.
  let recenterKey = $state("init");
  // Narrow viewports get a further-out default frame.
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => (isMobile = mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  });

  // MapView's error card is up (`onError`). The loader steps aside for it
  // rather than frosting over it, and comes back if the map turns up after
  // all — a map that only timed out loads late, and its fountains with it.
  let mapFailed = $state(false);

  // Settles when MapView reports a real load over a usable basemap, however
  // late that is (a background tab only loads once it is shown).
  let markMapLoaded!: () => void;
  const mapLoaded = new Promise<void>((resolve) => (markMapLoaded = resolve));

  async function load() {
    busy = true;
    err = null;
    try {
      const found = await fetchRegionFountains("dc", { timeoutMs: FETCH_TIMEOUT_MS });
      // Held for the map, so the dots — and the refit to them — land on a map
      // the visitor can see, as they did when the request waited for it.
      await mapLoaded;
      nowMs = Date.now();
      fountains = found;
      // Refit to the returned points' bounding box.
      recenterKey = `loaded-${found.length}`;
    } catch (e) {
      // Record whatever went wrong, in words meant for the visitor; `showErr`
      // decides if it's worth showing.
      err = fountainLoadErrorMessage(e);
    } finally {
      busy = false;
    }
  }

  // Ask straight away, alongside the map rather than after it. The area is
  // fixed — nothing in the request depends on the map's view — so there is
  // nothing to wait for: the request runs while the map fetches its tiles and
  // draws its first frame, and with the CDN holding the reply it is often
  // back first.
  load();

  function onMapLoad() {
    mapFailed = false;
    markMapLoaded();
  }

  function onMapError() {
    mapFailed = true;
  }

  const buckets = $derived(fountains.map((f) => ({ f, bucket: bucketOf(f.tags, nowMs) })));

  const markers = $derived<MapMarker[]>(
    buckets.map(({ f, bucket }) => ({
      id: f.id,
      lat: f.lat,
      lon: f.lon,
      color: BUCKET_COLOR[bucket],
      dimmed: isOutOfService(f.tags),
      data: { f },
    })),
  );

  // Frame the map on the dense core, not every point: drop the farthest ~35%
  // before fitting so the outliers don't zoom the map all the way out.
  const fitPoints = $derived.by<[number, number][] | undefined>(() => {
    if (markers.length < 2) return undefined;
    const byDist = markers
      .map((m) => ({ m, d: haversine(CENTER_PT, { lat: m.lat, lon: m.lon }) }))
      .sort((a, b) => a.d - b.d);
    const keep = Math.max(2, Math.ceil(byDist.length * 0.65));
    return byDist.slice(0, keep).map(({ m }) => [m.lat, m.lon]);
  });

  const loading = $derived(busy && !mapFailed && fountains.length === 0);
  const succeeded = $derived(!busy && !err && fountains.length > 0);

  // Defer showing the error. A genuine failure sits still and crosses the delay;
  // a flash — navigating away, an unmount, or a superseded load — tears down
  // first, so its timer never fires and nothing paints. One rule, no per-cause
  // special cases.
  let showErr = $state(false);
  $effect(() => {
    if (!err || busy) {
      showErr = false;
      return;
    }
    const t = setTimeout(() => (showErr = true), 400);
    return () => clearTimeout(t);
  });
</script>

<div class="relative h-full w-full {className}">
  <MapView
    class="hero-map"
    center={DC_CENTER}
    zoom={isMobile ? 7.8 : 11.3}
    minZoom={7}
    maxZoom={18}
    interactive
    showLocate
    showFullscreen
    onLoad={onMapLoad}
    onError={onMapError}
    {markers}
    markerRadius={6}
    {fitPoints}
    fitOptions={{ padding: [4, 4], maxZoom: isMobile ? 14 : 18 }}
    recenterKey={`${recenterKey}-${isMobile}`}
    {markerPopup}
  />

  <!-- First-load: a spacious, self-narrating loader. On success the bar rushes
       to 100%, then the whole overlay fades away. -->
  <SearchProgress
    active={loading}
    done={succeeded}
    failed={showErr}
    steps={LOADING_STEPS}
    variant="overlay"
  />

  <!-- Fetch failed (and the error outlived the flash window): floating retry card. -->
  {#if showErr && err}
    <div class="absolute top-3 left-3 z-[700] max-w-xs">
      <ErrorNotice message={err} tone="light" onRetry={load} retrying={busy} />
    </div>
  {/if}
</div>

{#snippet markerPopup(m: MapMarker)}
  {@const f = (m.data as { f: Fountain }).f}
  <FountainPopup {f} />
{/snippet}
