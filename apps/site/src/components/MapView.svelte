<script module lang="ts">
  import type { Snippet } from "svelte";
  import type * as maplibregl from "maplibre-gl";
  import { ROUTE_LINE, START_FLAG } from "@/lib/basemap/routeLine";
  import {
    BECKON_REACH_PX,
    DEFAULT_MARKER_RADIUS,
    MARKER_STROKE_PX,
    PULSE_GROWTH,
    PULSE_OPACITY,
    RUNNER_DOT,
  } from "@/lib/basemap/markerStyle";

  export type MapMarker = {
    id: number | string;
    lat: number;
    lon: number;
    color: string;
    label?: string;
    // Render at reduced opacity — used for context-only points.
    dimmed?: boolean;
    // Fired when the marker is tapped and no `markerPopup` is supplied.
    onClick?: () => void;
    // Arbitrary payload the `markerPopup` snippet reads to render its content.
    data?: unknown;
    // Opt a specific marker out of opening a popup even when `markerPopup` is set.
    noPopup?: boolean;
    // Which side of the marker its popup opens on: above it (`bottom`, the
    // popup's anchor is its bottom edge — the default) or below it (`top`).
    // For a marker whose popup would otherwise open into something the page
    // paints over the map, or off its top edge. Under `centerOnSelect` this is
    // a preference: honoured whenever the card fits there once the camera has
    // moved, overruled when only the other side can hold it (`popupSide`).
    popupAnchor?: "top" | "bottom";
    // Changing this replays the label's pop-in (the `marker-pop` keyframe in
    // globals.css) without touching the marker set — for a marker that has just
    // changed state and should be seen to.
    popKey?: string | number;
  };

  /** Gap between a marker and the tip of its popup, in px. */
  const POPUP_OFFSET_PX = 14;

  const MARKERS_SOURCE = "markers";
  const MARKERS_LAYER = "markers-circle";
  const RUNNER_SOURCE = "runner";
  const RUNNER_LAYER = "runner-circle";
  const LINE_SOURCE = "route-line";
  const LINE_LAYER = "route-line-drawn";
  /** Each source this component adds, and the layer that draws it. */
  const OWN_LAYER_OF: Record<string, string> = {
    [LINE_SOURCE]: LINE_LAYER,
    [MARKERS_SOURCE]: MARKERS_LAYER,
    [RUNNER_SOURCE]: RUNNER_LAYER,
  };
  // The runner dot (`RUNNER_DOT`), in the line's own blue.
  const RUNNER_PAINT: maplibregl.CircleLayerSpecification["paint"] = {
    "circle-radius": RUNNER_DOT.radius,
    "circle-color": ROUTE_LINE.color,
    "circle-stroke-width": RUNNER_DOT.stroke,
    "circle-stroke-color": "#fff",
  };
  const PULSE_LAYER = "markers-pulse";
  /**
   * How long a newly appeared dot takes to grow to full size. Exported for a
   * caller timing something to start once the dots have settled.
   */
  export const MARKER_POP_MS = 340;

  // Shared by every line layer here. A module constant rather than an inline
  // literal so the layer's layout effect sees one object and never re-runs.
  const LINE_LAYOUT = { "line-cap": "round", "line-join": "round" } as const;
  /** The `lineUpcoming` layer: the drawn line's own width and colour, faint. */
  const UPCOMING_PAINT = {
    "line-color": ROUTE_LINE.color,
    "line-width": ROUTE_LINE.width,
    "line-opacity": ROUTE_LINE.upcomingOpacity,
  } as const;

  /**
   * A `line-gradient` that paints the line up to `progress` (0–1 of its
   * length) and nothing past it.
   *
   * The edge is a short ramp rather than a hard step. MapLibre renders a
   * gradient into a texture along the line, and a `step` expression is drawn
   * at a much higher resolution with nearest filtering — a tip that hops a
   * texel at a time — where `interpolate` stays at 256 texels, linearly
   * filtered, so the tip glides. The ramp is ~1/200 of the route, about three
   * pixels at the zooms the hero uses.
   *
   * Same colour on both stops: only alpha changes across the ramp.
   */
  const GRADIENT_RAMP = 0.005;
  // `ROUTE_LINE.color` with an alpha: the gradient only ever varies alpha.
  const rgba = (a: number) => {
    const hex = ROUTE_LINE.color;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };
  function gradientExpr(progress: number): maplibregl.ExpressionSpecification {
    if (progress <= 0)
      return ["interpolate", ["linear"], ["line-progress"], 0, rgba(0), 1, rgba(0)];
    if (progress >= 1)
      return ["interpolate", ["linear"], ["line-progress"], 0, rgba(1), 1, rgba(1)];
    const lo = Math.max(0, Math.min(1 - GRADIENT_RAMP, progress - GRADIENT_RAMP));
    const hi = lo + GRADIENT_RAMP;
    return ["interpolate", ["linear"], ["line-progress"], lo, rgba(1), hi, rgba(0)];
  }

  /**
   * Paint for the ping a marker gives off when a caller `pulses` it: a ring in
   * the marker's own colour that grows out from under the dot and thins to
   * nothing as `pulse` runs 0 → 1.
   *
   * Driven by feature-state, not by feature properties or a paint uniform,
   * and that is the whole point of the layer: the expressions below never
   * change, so updating a pulse is one `setFeatureState` for that feature —
   * no source reload, no re-upload of the marker data, and no interference
   * with the dot layer's own radius, which stays a plain uniform. At `pulse` 0
   * (every feature that is not pulsing) the ring is fully transparent, so it
   * is never seen under a dot that is still growing in.
   */
  function pulsePaint(baseRadius: number): maplibregl.CircleLayerSpecification["paint"] {
    const p: maplibregl.ExpressionSpecification = ["coalesce", ["feature-state", "pulse"], 0];
    return {
      "circle-radius": ["+", baseRadius, ["*", baseRadius * PULSE_GROWTH, p]],
      "circle-color": ["get", "color"],
      "circle-opacity": ["case", [">", p, 0], ["*", PULSE_OPACITY, ["-", 1, p]], 0],
    };
  }

  const ATTRIBUTION =
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OSM</a>';

  // Marker set → GeoJSON. `id`s may be strings, so the lookup key rides in
  // properties as `mid`; feature.id stays numeric-only.
  function markersToFeatures(markers: MapMarker[]): GeoJSON.FeatureCollection {
    return {
      type: "FeatureCollection",
      features: markers.map((m) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [m.lon, m.lat] },
        properties: { mid: String(m.id), color: m.color, dimmed: !!m.dimmed },
      })),
    };
  }

  function boundsOf(pts: [number, number][]): [[number, number], [number, number]] {
    let minLat = Infinity,
      minLon = Infinity,
      maxLat = -Infinity,
      maxLon = -Infinity;
    for (const [lat, lon] of pts) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    return [
      [minLon, minLat],
      [maxLon, maxLat],
    ];
  }

  // Web Mercator, matching MapLibre's own projection (512px tiles, north-up, no
  // pitch — every map here disables rotation and pitch). This exists so a view
  // can be measured *without* flying the camera there and reading `getBounds()`
  // back: the opening view has to stay the reference even after the visitor has
  // panned and zoomed away from it.
  const WORLD_TILE_PX = 512;
  const lonToX = (lon: number) => (lon + 180) / 360;
  const latToY = (lat: number) => {
    const rad = (lat * Math.PI) / 180;
    return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  };
  const xToLon = (x: number) => x * 360 - 180;
  const yToLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

  /**
   * The ground a `width`×`height` box covers when centred on `center` at `zoom`,
   * optionally grown by `slack` — a fraction of the box added to every side.
   *
   * Returned as MapLibre's `[[west, south], [east, north]]`.
   *
   * The 1px on each axis is not cosmetic: MapLibre's camera constraint responds
   * to a viewport *larger* than its `maxBounds` by zooming in to fit, so bounds
   * computed to land exactly on the viewport edge can tip over that line on a
   * rounding error and quietly nudge the opening zoom.
   */
  function viewportBounds(
    center: [number, number],
    zoom: number,
    width: number,
    height: number,
    slack = 0,
  ): [[number, number], [number, number]] {
    const worldPx = WORLD_TILE_PX * 2 ** zoom;
    const dx = (width * (0.5 + slack) + 1) / worldPx;
    const dy = (height * (0.5 + slack) + 1) / worldPx;
    const x = lonToX(center[1]);
    const y = latToY(center[0]);
    return [
      [xToLon(x - dx), yToLat(Math.min(1, y + dy))],
      [xToLon(x + dx), yToLat(Math.max(0, y - dy))],
    ];
  }

  // Overshoot easing so dots pop past full size then settle — matches the label
  // keyframe in globals.css.
  function easeOutBack(t: number): number {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import "maplibre-gl/dist/maplibre-gl.css";
  import Beckon from "@/components/Beckon.svelte";
  import rawMapStyle from "@/lib/basemap/map-style.json";
  import {
    MapLibre,
    GeoJSONSource,
    CircleLayer,
    LineLayer,
    Marker,
    Popup,
    AttributionControl,
    CustomControl,
    GeolocateControl,
    FullScreenControl,
  } from "svelte-maplibre-gl";
  import { setMapPopup } from "@/lib/mapPopup";
  import { ArrowCounterClockwise, FlagIcon } from "phosphor-svelte";

  type Props = {
    center: [number, number];
    zoom?: number;
    minZoom?: number;
    maxZoom?: number;
    // Pen the camera into the view the map opened on: it can zoom in and pan
    // around inside that view, but never pull back past the opening zoom, and
    // never drag more than a margin past the ground the first frame showed (see
    // `LOCK_SLACK`). Overrides `minZoom`.
    lockToOpeningView?: boolean;
    // Whether the visitor can move the map or tap its markers. Off, every
    // gesture handler is disabled, taps on markers and on the ground are
    // ignored, and the view controls are disabled — the map is a picture
    // until it is turned back on. Reactive: a page can lock the map while
    // it is showing something (the hero's replay) and unlock it after.
    interactive?: boolean;
    // Defaults to `interactive`.
    scrollWheelZoom?: boolean;
    // MapLibre's cooperative gestures: the wheel scrolls the page unless a
    // modifier is held, and one finger scrolls the page while two move the map.
    // For a map that fills the width of a page that continues below it —
    // without this, the map is a scroll trap the size of the screen.
    // MapLibre's own explanation — a dimming screen that flashes over the whole
    // map on every wheel tick — is suppressed (see the style block); the view
    // controls in the bottom-left corner (zoom in, zoom out, reset) are the
    // visible way to move the map instead.
    cooperativeGestures?: boolean;
    // Add MapLibre's GeolocateControl: a "locate me" button that drops a blue
    // dot at the visitor's position, an accuracy halo, and — where the device
    // exposes orientation — a heading cone. MapLibre handles the geolocation
    // and (on iOS) the device-orientation permission prompt on tap.
    showLocate?: boolean;
    // Add MapLibre's FullScreenControl (a fullscreen toggle for the map).
    showFullscreen?: boolean;
    markers?: MapMarker[];
    markerRadius?: number;
    line?: [number, number][];
    // How much of `line` is drawn, 0–1 of its length, for a caller animating
    // the line in. Given at all — even as 0 — the line's source is built with
    // `lineMetrics` and its layer with a `line-gradient`, both of which MapLibre
    // needs from the start; a caller cannot begin without it and opt in later.
    lineProgress?: number;
    // Draw the whole of `line` faintly beneath the drawn part — the route
    // still to come, under a `lineProgress` that has not reached it.
    lineUpcoming?: boolean;
    // A `[lat, lon]` to plant the start flag on (`START_FLAG`): where a route
    // begins. Decoration — no popup, not tappable, and not a marker.
    start?: [number, number];
    // A `[lat, lon]` to mark with a small dot: the runner's position. Drawn
    // as a circle layer *under* the markers, so on reaching a stop it tucks
    // in beneath the stop's dot and the label stays clean; a DOM marker would
    // ride over everything on the canvas. One point in its own source, so a
    // frame's move is one tiny `setData`.
    runner?: [number, number];
    // Marker id → 0–1: a ping the marker gives off, at that point in its life.
    // Per-frame state travels here rather than inside `markers`, so a pulse
    // never causes the marker set — and every label — to be rebuilt.
    pulses?: Record<string, number>;
    // The id of a marker calling for a tap, as a string, or null for none: it
    // lets soft waves in the route's blue out from under its dot on a double
    // beat — two close together, then a rest — until the caller clears it. A
    // call to action, not a status — louder than a `pulses` ping, and on a
    // loop where a ping marks one moment. Drawn in CSS over the map rather
    // than on the canvas, so the loop costs no repaint.
    beckon?: string | null;
    // When the beckon's loop began, as a `performance.now()` time, for a
    // beckon that has to join a loop already running elsewhere — the hero's,
    // started by its loading frame before this map existed — rather than
    // start its own when it mounts (see `Beckon`).
    beckonSince?: number;
    // Whether the markers pop in when the map first draws them: dots growing
    // from nothing, labels and the start flag scaling in. For a map that
    // dissolves out of a loading frame already showing them at full size, off
    // — a pop there is a flicker at the hand-off. Later changes still pop: a
    // new marker set, a label's `popKey`.
    popInOnLoad?: boolean;
    onViewChange?: (
      view: {
        lat: number;
        lon: number;
        radiusM: number;
        bounds: [[number, number], [number, number]];
      },
      userInitiated: boolean,
    ) => void;
    recenterKey?: string;
    fitPoints?: [number, number][];
    fitOptions?: { padding?: [number, number]; maxZoom?: number };
    centerOnSelect?: boolean;
    // The id of the marker whose popup is open, as a string, or null for none.
    // Bindable: a tap on a marker sets it and a tap elsewhere clears it, and a
    // page can set it to open a marker's popup itself, or read it to learn
    // which marker the visitor opened. Under `centerOnSelect` a selection
    // made either way brings the marker in.
    selected?: string | null;
    class?: string;
    // Hide the basemap's place-name labels (city/town/suburb/etc). Demo map
    // opts in so the fixed DC region doesn't read as a real, named place.
    hidePlaceLabels?: boolean;
    // Fired on a fatal (pre-load) map failure so callers can stop their own
    // loaders and let the error surface.
    onError?: (err: unknown) => void;
    // Fired once, when the map tells its loading frame to clear — the same
    // moment as the `rosm:map-ready` event, for the caller that rendered this
    // map and wants to start something the visitor will actually see. Fires
    // on failure too (the frame clears to the error card either way).
    onReady?: () => void;
    // Rendered inside the map popup when a marker is tapped, given that marker.
    markerPopup?: Snippet<[MapMarker]>;
  };

  let {
    center,
    zoom = 14,
    minZoom,
    maxZoom,
    lockToOpeningView = false,
    interactive = true,
    scrollWheelZoom,
    cooperativeGestures = false,
    showLocate = false,
    showFullscreen = false,
    markers = [],
    markerRadius = DEFAULT_MARKER_RADIUS,
    line,
    lineProgress,
    lineUpcoming = false,
    start,
    runner,
    pulses,
    beckon = null,
    beckonSince,
    popInOnLoad = true,
    onViewChange,
    recenterKey,
    fitPoints,
    fitOptions,
    centerOnSelect = false,
    selected = $bindable(null),
    class: className,
    hidePlaceLabels = false,
    onError,
    onReady,
    markerPopup,
  }: Props = $props();

  // The style document, bundled rather than fetched.
  //
  // It used to live in `public/` and reach MapLibre as the URL
  // "/map-style.json", which put a 64KB round trip in front of every tile the
  // map would ever request — and that request could not even be issued until
  // the island had downloaded, hydrated and built a map, so it landed at the
  // very end of the page's network graph. Bundled, it is in memory by the time
  // `<MapLibre>` mounts and the first thing the map does is ask for tiles.
  //
  // Cloned per instance because MapLibre takes ownership of the object it is
  // handed and writes to it; two maps on one page (the landing page has two)
  // sharing this import would otherwise share those mutations.
  const mapStyle = structuredClone(rawMapStyle) as maplibregl.StyleSpecification;

  let map = $state<maplibregl.Map | undefined>();
  // Tracked here rather than as the prop's fallback so it follows a change
  // to `interactive` after mount.
  const wheelZoom = $derived(scrollWheelZoom ?? interactive);
  // 0 → 1 grow factor for the pop-in.
  let popScale = $state(1);

  // Popup content dismisses itself through this context (was useMapPopup).
  setMapPopup({ close: () => (selected = null) });

  // Duration for a camera move this component starts: the given length, or a
  // cut when the visitor has asked for reduced motion.
  const motionMs = (ms: number) =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : ms;

  // The part of the box the map is actually seen through, as the px each edge
  // of the box is covered by — see the `.map-view-visible` element in the
  // markup for how a page declares it. Moves this component makes on its own
  // (bringing a tapped marker in, the zoom buttons) aim at the middle of that
  // area rather than the middle of the box, where on a page that paints copy
  // over one side of the map they would land half under the copy.
  //
  // Deliberately *not* handed to MapLibre as `padding`, which looks like the
  // same idea. Padding redefines the map's centre as the visible area's: the
  // opening view is then drawn there, so the whole map slides sideways out
  // from under the loading frame that was rendered around the box's centre,
  // and the pen (`maxBounds`) constrains a point that is no longer the box's
  // centre. Keeping the map's own centre where it is and doing the arithmetic
  // here leaves the frame, the pen, and every other camera move exactly as
  // they were.
  let visibleInset = $state({ top: 0, right: 0, bottom: 0, left: 0 });
  let visibleEl = $state<HTMLDivElement | undefined>();
  // The measure above, for `handleLoad` to run once the controls are in the DOM.
  let measureVisible: (() => void) | undefined;

  $effect(() => {
    const box = root;
    const area = visibleEl;
    if (!box || !area) return;
    const measure = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      // Mid-layout the box reports 0; the observer will fire again once it has
      // a size.
      if (!w || !h) return;
      // `offset*` rather than bounding rects: the box is the area's offset
      // parent, so these are its layout position inside the box, unaffected
      // by any transform an ancestor (a reveal, say) is animating.
      let next = {
        top: area.offsetTop,
        left: area.offsetLeft,
        right: w - area.offsetLeft - area.offsetWidth,
        bottom: h - area.offsetTop - area.offsetHeight,
      };
      // The map's own furniture along the bottom edge — the view controls
      // stacked in one corner, the attribution in the other — is cover too:
      // a marker aimed at the middle of the area declared by the page lands
      // with its popup's foot among the buttons. MapLibre lays each corner's
      // controls out in a container pinned to the box's bottom edge (lifted by
      // `--map-ctrl-inset-bottom`), so the taller container's top is where
      // the clear ground ends. Read off the DOM rather than summed from the
      // controls' known sizes, so adding one later changes nothing here.
      for (const corner of box.querySelectorAll<HTMLElement>(
        ".maplibregl-ctrl-bottom-left, .maplibregl-ctrl-bottom-right",
      )) {
        if (corner.offsetHeight) next.bottom = Math.max(next.bottom, h - corner.offsetTop);
      }
      // Insets that leave nothing between them are a page bug; the whole box
      // is the only sane answer, and a degenerate area would aim moves at a
      // point outside the map.
      if (next.top + next.bottom >= h || next.left + next.right >= w) {
        next = { top: 0, right: 0, bottom: 0, left: 0 };
      }
      const cur = visibleInset;
      if (
        next.top !== cur.top ||
        next.right !== cur.right ||
        next.bottom !== cur.bottom ||
        next.left !== cur.left
      ) {
        visibleInset = next;
      }
    };
    // Both observed: the area moves without resizing when a page swaps one
    // inset for another of the same size, but the box's own resize is the
    // usual reason either changes. The control containers are not observed —
    // they are laid out once the map mounts, which `handleLoad` follows with
    // a measure, and hold their size from then on.
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(area);
    measureVisible = measure;
    return () => {
      ro.disconnect();
      measureVisible = undefined;
    };
  });

  // Where the box's centre sits relative to the visible area's, in px. To put
  // a point in the middle of the visible area, the map's centre — the point
  // the opening view was drawn around and the pen (`clampToPen`) is measured
  // from — goes this far from it.
  function boxCentreOffset(): [number, number] {
    const i = visibleInset;
    return [(i.right - i.left) / 2, (i.bottom - i.top) / 2];
  }

  // The middle of the visible area, as the ground under it right now. What the
  // zoom buttons zoom about: MapLibre's default is the box's centre, which on
  // a half-covered map is at the visible area's edge, so every press would
  // slide the ground the visitor is looking at away toward the cover.
  function visibleCentre(): maplibregl.LngLat | undefined {
    if (!map) return;
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const i = visibleInset;
    return map.unproject([(i.left + w - i.right) / 2, (i.top + h - i.bottom) / 2]);
  }

  // The view controls (see `cooperativeGestures`). MapLibre's own
  // NavigationControl is not used because it cannot take a third button, and
  // three buttons in one group read as one control where two groups read as
  // two: reset alone on top, the zoom pair beneath it. Zoom in/out borrow
  // MapLibre's button classes so they get its icons and disabled styling;
  // reset is ours.
  //
  // Whether either zoom button has anything left to do. Read off the map at
  // every zoom rather than derived from the props: the map's own limits are
  // the truth (`lockToOpeningView` sets the floor from `zoom`, and MapLibre
  // may clamp `maxZoom` against the style).
  let atMinZoom = $state(false);
  let atMaxZoom = $state(false);
  function trackZoomLimits() {
    if (!map) return;
    const z = map.getZoom();
    atMinZoom = z <= map.getMinZoom();
    atMaxZoom = z >= map.getMaxZoom();
  }

  // Back to the view the map opened on — the configured `center`/`zoom`, the
  // same pair the loading frame was drawn at, not wherever the camera was when
  // it loaded. Under `lockToOpeningView` that view is inside the pen by
  // construction, so this move never has to be clamped.
  function resetView() {
    map?.easeTo({
      center: [center[1], center[0]],
      zoom,
      duration: motionMs(600),
      essential: true,
    });
  }

  const markerData = $derived(markersToFeatures(markers));
  const markerById = $derived(new Map(markers.map((m) => [String(m.id), m])));
  // Signature of the marker *set* (ids only): recolors keep ids, so the pop-in
  // fires only when points actually appear.
  const markerIdSig = $derived(markers.map((m) => m.id).join("|"));
  const labeled = $derived(markers.filter((m) => m.label));
  const beckonMarker = $derived(
    beckon == null ? undefined : markers.find((m) => String(m.id) === beckon),
  );
  const runnerData = $derived<GeoJSON.Feature | null>(
    runner
      ? {
          type: "Feature",
          geometry: { type: "Point", coordinates: [runner[1], runner[0]] },
          properties: {},
        }
      : null,
  );

  const lineData = $derived<GeoJSON.Feature | null>(
    line && line.length > 1
      ? {
          type: "Feature",
          geometry: { type: "LineString", coordinates: line.map(([la, lo]) => [lo, la]) },
          properties: {},
        }
      : null,
  );
  const selectedMarker = $derived(selected != null ? markerById.get(selected) : undefined);

  const radius = $derived(Math.max(0, markerRadius * popScale));
  const strokeW = $derived(Math.max(0, MARKER_STROKE_PX * popScale));

  // The drawn line's paint. Under `lineProgress` the gradient is part of it
  // from the first frame, and each change is one `setPaintProperty`: the
  // layer wrapper diffs paint by key, and a gradient over `line-progress` is
  // not a data-driven expression, so MapLibre re-renders its colour ramp
  // without relaying out the source.
  const linePaint = $derived.by<maplibregl.LineLayerSpecification["paint"]>(() => {
    const paint: maplibregl.LineLayerSpecification["paint"] = {
      "line-color": ROUTE_LINE.color,
      "line-width": ROUTE_LINE.width,
      "line-opacity": ROUTE_LINE.opacity,
    };
    if (lineProgress !== undefined) paint["line-gradient"] = gradientExpr(lineProgress);
    return paint;
  });

  // Push `pulses` into feature-state (see `pulsePaint`). Only the difference
  // is written: a pulse that has ended is cleared so its feature falls back
  // to the transparent ring, and one that continues is overwritten in place.
  let pulsing = new Set<string>();
  $effect(() => {
    const next = pulses;
    if (!next || !isLoaded || !map) return;
    const m = map;
    if (!m.getSource(MARKERS_SOURCE)) return;
    const ids = new Set(Object.keys(next));
    for (const id of pulsing) {
      if (!ids.has(id)) m.removeFeatureState({ source: MARKERS_SOURCE, id }, "pulse");
    }
    for (const id of ids) m.setFeatureState({ source: MARKERS_SOURCE, id }, { pulse: next[id] });
    pulsing = ids;
  });

  // Recenter / fit on explicit request (recenterKey change), never fighting a pan.
  function doRecenter() {
    if (!map) return;
    if (fitPoints && fitPoints.length >= 2) {
      const [padX, padY] = fitOptions?.padding ?? [60, 60];
      map.fitBounds(boundsOf(fitPoints), {
        padding: { top: padY, bottom: padY, left: padX, right: padX },
        maxZoom: fitOptions?.maxZoom ?? 16,
        duration: 0,
      });
    } else {
      map.jumpTo({ center: [center[1], center[0]] });
    }
  }

  $effect(() => {
    recenterKey; // track
    if (!map) return;
    untrack(doRecenter);
  });

  // Confine the camera to the opening view (see `lockToOpeningView`).
  //
  // The floor is the opening zoom, and it goes in as a plain prop so MapLibre is
  // built with it — there is no first moment where the map can be pulled back
  // past its own opening frame.
  const zoomFloor = $derived(lockToOpeningView ? zoom : minZoom);

  // The pen is the ground the opening view covers, which needs the container's
  // pixel size, so it can only be measured once the box exists. Held as state
  // and handed to `<MapLibre>` as a prop rather than pushed onto the map by
  // hand: the component already owns `maxBounds` and would overwrite an
  // imperative `setMaxBounds` the next time the prop changed.
  //
  // Measured from the `center`/`zoom` this map was *configured* with — the same
  // pair `frames.ts` pre-rendered the loading frame at — never from where the
  // camera currently sits. That is what makes it safe to re-measure after a
  // resize: reading the live camera instead would pen the visitor into whatever
  // they had panned to at the moment they resized.
  let openingBounds = $state<[[number, number], [number, number]] | undefined>();

  /**
   * How far past the opening view the pen reaches, as a fraction of the box on
   * every side.
   *
   * Not zero, because a pen drawn exactly on the opening view pins the camera
   * completely at the opening zoom — and this map moves the camera itself:
   * `centerOnSelect` brings a tapped marker in so its popup has somewhere to go.
   * With no margin that move is clamped to nothing and a popup on an edge marker
   * opens half outside the frame.
   *
   * Sized so an edge marker lands at the visible area's centre with its popup
   * *within* the frame, rather than with one side flush against it: centring a
   * marker that started on the edge costs about half the box, and where the
   * visible area's centre is off the box's (see `visibleInset`) a bit more.
   * Short of the 0.5 that would let the route itself be panned entirely out of
   * view.
   */
  const LOCK_SLACK = 0.4;

  function applyViewLock() {
    if (!lockToOpeningView || !map) {
      openingBounds = undefined;
      return;
    }
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    // A container mid-layout reports 0, which would make a degenerate pen.
    if (!w || !h) return;
    openingBounds = viewportBounds(center, zoom, w, h, LOCK_SLACK);
  }

  $effect(() => {
    lockToOpeningView;
    center;
    zoom;
    if (!isLoaded) return;
    untrack(applyViewLock);
  });

  // `isLoaded` tracks the real map `load` event only. It is never forced true
  // on a timer — a blank/hung map must not masquerade as loaded, or the loader
  // hides over nothing and later errors get swallowed by the post-load gate.
  let isLoaded = $state(false);
  let hasError = $state(false);

  // The element `MapFrame.astro`'s loading overlay listens on. The reveal
  // travels as a bubbling DOM event, so the island and the server-rendered
  // frame share nothing but the DOM — no ids to keep in sync across the Astro
  // boundary, and several maps on one page each clear their own frame.
  let root = $state<HTMLDivElement | undefined>();

  // One-shot: whichever of the paths below gets there first, the frame is told
  // exactly once.
  //
  // What counts as "drawn" decides how long the visitor looks at a picture of
  // a map instead of the map — and a picture that *is* this map (the hero's,
  // route and all) dissolves into whatever has been drawn by then. So drawn
  // means the opening view with this component's own route and markers on it:
  //
  // - the first frame, from `load` on, by which every source this component
  //   adds has drawn (`ownSourcesDrawn`). `load` itself waits for the style
  //   and every basemap tile in view, but the route, markers and runner are
  //   added by child components and parsed in a worker, and can land frames
  //   later: revealed on `load` alone, they blink in after the picture of
  //   them has already gone.
  // - `idle`, once everything in view has loaded and rendered, for a map that
  //   went quiet before any frame passed that test.
  // - `DRAWN_GRACE_MS` after `load`, whatever has drawn: a source that never
  //   reports must not hold a working map behind its picture.
  // - failure, either an error or the load timeout below. A stale picture is
  //   still better than a loading state that never ends, and the error card
  //   this component renders is *underneath* the overlay.
  let signalledReady = false;
  function signalReady() {
    if (signalledReady) return;
    signalledReady = true;
    // One frame of slack: `load` fires *before* the browser has composited that
    // first frame, so revealing synchronously can dissolve to a blank canvas.
    requestAnimationFrame(() => {
      root?.dispatchEvent(new CustomEvent("rosm:map-ready", { bubbles: true }));
      onReady?.();
    });
  }

  // The sources this component has added and expects drawn: the markers
  // always, the line and the runner when there are any.
  function ownSources(): string[] {
    const ids = [MARKERS_SOURCE];
    if (lineData) ids.push(LINE_SOURCE);
    if (runnerData) ids.push(RUNNER_SOURCE);
    return ids;
  }

  // Which of this component's sources have drawn at least once. Latched off
  // MapLibre's `sourcedata`: a source counts once a tile of it has loaded —
  // drawn from the next frame on, and kept on screen through any later reload
  // — or once it reports itself loaded with its layer in place, which is the
  // only report a source with nothing in view ever makes. Latched rather than
  // asked with `isSourceLoaded` at the moment of revealing, because the
  // runner's source is re-set on every frame of the hero's replay and is
  // almost never idle at any given moment.
  // Not a `SvelteSet`: it is read only from MapLibre's event handlers, never
  // by anything reactive, so there is nothing for it to notify.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const drawnSources = new Set<string>();
  const ownSourcesDrawn = () => ownSources().every((id) => drawnSources.has(id));

  /** After a frame is drawn: tell the frame if that frame had everything on it. */
  function signalIfDrawn() {
    if (isLoaded && ownSourcesDrawn()) signalReady();
  }

  /** On `idle`: everything in view is loaded and drawn, so only our layers need to exist. */
  function signalIfIdle() {
    if (isLoaded && ownSources().every((id) => map?.getLayer(OWN_LAYER_OF[id]))) signalReady();
  }

  $effect(() => {
    const m = map;
    if (!m) return;
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      const layer = OWN_LAYER_OF[e.sourceId];
      if (!layer || drawnSources.has(e.sourceId)) return;
      if (e.tile || (e.isSourceLoaded && m.getLayer(layer))) drawnSources.add(e.sourceId);
    };
    // `render` fires once a frame has been drawn, so a source latched before
    // it was on it.
    const onRender = () => {
      signalIfDrawn();
      if (signalledReady) m.off("render", onRender);
    };
    m.on("sourcedata", onSourceData);
    m.on("render", onRender);
    return () => {
      m.off("sourcedata", onSourceData);
      m.off("render", onRender);
    };
  });

  /** How long after `load` the frame is told regardless of what has drawn. */
  const DRAWN_GRACE_MS = 3000;
  $effect(() => {
    if (!isLoaded) return;
    const timer = setTimeout(() => {
      if (signalledReady) return;
      console.warn("MapView: sources not drawn", DRAWN_GRACE_MS, "ms after load; revealing anyway");
      signalReady();
    }, DRAWN_GRACE_MS);
    return () => clearTimeout(timer);
  });

  // Keep the canvas the same size as the box it sits in.
  //
  // MapLibre already watches the container, but not in a way this layout can
  // rely on (`Map._setupResizeObserver`): it *discards its observer's first
  // callback* — so any size the box settles into between construction and that
  // first delivery is never applied — and throttles the rest to 50ms, which the
  // canvas spends overhanging the frame's rounded corners mid-drag. Both show up
  // as a map drawn at the wrong size for its card.
  //
  // Every map on this site is sized in `vw`/percentage units by its caller, so
  // the box moves under the canvas constantly. `resize()` only reads the
  // container rect and re-sizes the drawing buffer; running it per animation
  // frame is cheaper than being wrong for three of them.
  $effect(() => {
    const el = root;
    const m = map;
    if (!el || !m) return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        m.resize();
        // The box just changed how much ground it covers, so the opening-view
        // pen no longer matches it. Re-measure rather than leave a map that has
        // to zoom in to satisfy stale bounds.
        applyViewLock();
      });
    });
    observer.observe(el);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  });

  // Hard ceiling: MapLibre can sit forever if the tile source (via /api/tiles →
  // OpenFreeMap) stalls without ever firing `load` or `error`. Give up at 20s so
  // the loader can't spin indefinitely — surface the fallback instead.
  const LOAD_TIMEOUT_MS = 20_000;
  $effect(() => {
    if (isLoaded || hasError) return;
    const timer = setTimeout(() => {
      if (!isLoaded) {
        console.error("MapLibre load timeout after", LOAD_TIMEOUT_MS, "ms");
        hasError = true;
        signalReady();
        onError?.(new Error("Map load timed out"));
      }
    }, LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  });

  // Defer painting the fallback: a genuine failure persists past the delay,
  // while a flash from tearing the map down during navigation never does — so
  // no error UI blinks on the outgoing page. Same rule the callers use.
  let showError = $state(false);
  $effect(() => {
    if (!hasError) {
      showError = false;
      return;
    }
    const t = setTimeout(() => (showError = true), 400);
    return () => clearTimeout(t);
  });

  // Map/style/tile failures surface here. Flag once so the fallback replaces
  // the loader instead of leaving a stuck spinner or a blank canvas. Only
  // fatal (pre-load) failures trip it — a lone tile 404 on a working map
  // shouldn't wipe the whole view.
  function handleError(ev: maplibregl.ErrorEvent) {
    console.error("MapLibre error", ev.error);
    if (!isLoaded) {
      hasError = true;
      signalReady();
      onError?.(ev.error);
    }
  }

  // Pop new dots in: grow circle-radius 0 → target whenever the marker set
  // changes. Radius is a shader uniform, so this stays smooth for many points.
  // The set drawn on load pops only under `popInOnLoad`.
  let drewFirstSet = false;
  $effect(() => {
    markerIdSig; // track
    if (!isLoaded) {
      popScale = 0;
      return;
    }
    const firstSet = !drewFirstSet;
    drewFirstSet = true;
    if ((firstSet && !popInOnLoad) || motionMs(MARKER_POP_MS) === 0) {
      popScale = 1;
      return;
    }
    popScale = 0;
    const start = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / MARKER_POP_MS);
      popScale = easeOutBack(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  });

  /**
   * The nearest centre to `[lat, lon]` that keeps the whole viewport inside the
   * pen, at the zoom the map is currently on.
   *
   * Without this, a move toward a centre the pen forbids is corrected by
   * MapLibre *during* the animation — `maxBounds` is enforced every time the
   * transform's centre is set, so the camera travels out toward the requested
   * point and is dragged back frame by frame. Clamping the destination up front
   * gives the animation a centre it can actually reach, so the motion is one
   * continuous move instead of an overshoot and a recovery.
   *
   * A no-op when there is no pen.
   */
  function clampToPen(lat: number, lon: number): [number, number] {
    if (!map || !openingBounds) return [lat, lon];
    const { clientWidth: w, clientHeight: h } = map.getContainer();
    const worldPx = WORLD_TILE_PX * 2 ** map.getZoom();
    const halfW = w / 2 / worldPx;
    const halfH = h / 2 / worldPx;
    const [[west, south], [east, north]] = openingBounds;
    // A viewport wider than the pen has no valid range on that axis — the
    // midpoint is the only sensible answer, and it is what MapLibre settles on.
    const clamp = (v: number, lo: number, hi: number) =>
      lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
    return [
      yToLat(clamp(latToY(lat), latToY(north) + halfH, latToY(south) - halfH)),
      xToLon(clamp(lonToX(lon), lonToX(west) + halfW, lonToX(east) - halfW)),
    ];
  }

  // Which side of its marker the open popup is on. The marker's `popupAnchor`
  // is a preference, not a verdict: it says which side the page would rather
  // the card opened on, and it is honoured whenever the card fits there. What
  // decides is the effect below, once the card has a measured height — a tall
  // card on a marker near the floor of the visible area has to open upward
  // however the page would like it, or it opens into the furniture below.
  // `null` until that runs, when the preference is what is drawn.
  let popupSide = $state<"top" | "bottom" | null>(null);
  const popupAnchor = $derived(popupSide ?? selectedMarker?.popupAnchor ?? "bottom");
  // A new selection is a fresh decision; the side the last card settled on
  // says nothing about this one.
  $effect(() => {
    selected;
    popupSide = null;
    sidedFor = null;
  });
  // Which selection's card has had its side settled. The side is chosen once,
  // off the card's first measured height, and then left alone: choosing it
  // again when the card resizes would move a card the visitor is working in
  // from under their thumb, and — since the side is what the popup is keyed on
  // — rebuild the card mid-interaction. Later resizes still re-centre it; only
  // the side is fixed.
  let sidedFor: string | null = null;

  // Bring a tapped marker's popup to the middle of the visible area (demo
  // maps opt in via `centerOnSelect`): the card, not the marker. The card is
  // what the visitor reads next, and centring the marker leaves the card
  // pushed up toward the edge — or, for a popup that opens beneath its
  // marker, down. The marker sits a card's half-height off centre, on
  // whichever side its popup opens.
  //
  // Which side that is, and where the camera goes, are one decision: the offset
  // that centres the card is the card's whole reach on the side it opens, so
  // the two sides ask for camera destinations a card-height apart. Both are
  // costed here — the page's preferred side first — against the pen, because
  // near the pen's edge the camera cannot travel the whole way: the card lands
  // where the clamp left it, and one that was only ever going to fit on the
  // other side hangs out of the frame with its marker looking disconnected.
  //
  // Re-run on every change of the card's size, not once on open: these cards
  // are as tall as their content and their content changes under the visitor —
  // an action turns a four-button grid into a confirmation — and a card that
  // fitted below its marker at one height does not at the next.
  //
  // `offsetHeight`, which the pop-in's scale does not touch. If the popup never
  // appears (or the marker opens none) the marker itself is centred and the
  // preferred side stands.
  //
  // `easeTo`, not `flyTo`: flyTo flies an arc that pulls the camera back and in
  // again, which over a couple of hundred pixels is mostly swoop — and under a
  // `minZoom` floor it cannot even perform the pull-back, so it fights its own
  // curve. easeTo just moves.
  $effect(() => {
    selected; // track
    // A flip rebuilds the popup (see the `{#key}` on it), so the element this
    // watches is gone: re-run and re-attach to the new one.
    popupSide;
    if (!centerOnSelect || !map) return;
    const m = untrack(() => selectedMarker);
    if (!m) return;
    const mapInst = map;

    const place = (card?: HTMLElement, tip?: HTMLElement) => {
      const worldPx = WORLD_TILE_PX * 2 ** mapInst.getZoom();
      const [ox, oy] = untrack(boxCentreOffset);
      const { clientHeight: h } = mapInst.getContainer();
      const inset = untrack(() => visibleInset);
      // Where the map's own centre must be for the card to sit at the visible
      // area's centre (`boxCentreOffset`), worked out in map coordinates
      // rather than handed to `easeTo` as `offset`: the destination has to be
      // a real centre before it can be clamped against the pen, and `easeTo`
      // clamps whatever it is given as the centre, so given anything else it
      // would clamp the wrong point.
      //
      // `cardDy` is how far the card's centre is from the marker on screen, in
      // px, positive downward: the gap the popup keeps from the marker, the
      // tip, then half the card — on the side the popup opens.
      const plan = (side: "top" | "bottom") => {
        const half = (card?.offsetHeight ?? 0) / 2;
        const reach = card ? POPUP_OFFSET_PX + (tip?.offsetHeight ?? 0) + half : 0;
        const cardDy = side === "bottom" ? -reach : reach;
        const [lat, lon] = untrack(() =>
          clampToPen(
            yToLat(latToY(m.lat) + (oy + cardDy) / worldPx),
            xToLon(lonToX(m.lon) + ox / worldPx),
          ),
        );
        // Where the card actually lands, given a centre the pen may have cut
        // short: the marker's screen position after the move, plus the reach.
        // Measured against the visible area, so "fits" means fits where the
        // page says the map can be seen — not merely inside the canvas.
        const cardCentreY = h / 2 + (latToY(m.lat) - latToY(lat)) * worldPx + cardDy;
        const slack = Math.min(
          cardCentreY - half - inset.top,
          h - inset.bottom - (cardCentreY + half),
        );
        return { side, lat, lon, slack };
      };
      // Settled already: the card keeps its side, and this pass only re-centres
      // it at whatever height it now is.
      let best: ReturnType<typeof plan>;
      if (sidedFor === selected && popupSide) {
        best = plan(popupSide);
      } else {
        const preferred = m.popupAnchor ?? "bottom";
        const first = plan(preferred);
        const second = plan(preferred === "top" ? "bottom" : "top");
        // The preference wherever it fits; otherwise whichever side holds more
        // of the card, so a card too tall for either overflows the softer edge.
        best = first.slack >= 0 || first.slack >= second.slack ? first : second;
        sidedFor = selected;
        popupSide = best.side;
      }
      // Only move for a move worth making: a resize that leaves the camera
      // where it already is (or all but) must not restart the ease under a
      // card the visitor is reading.
      const c = mapInst.getCenter();
      const dx = Math.abs(lonToX(best.lon) - lonToX(c.lng)) * worldPx;
      const dy = Math.abs(latToY(best.lat) - latToY(c.lat)) * worldPx;
      if (Math.max(dx, dy) < 1) return;
      mapInst.easeTo({
        center: [best.lon, best.lat],
        duration: motionMs(600),
        essential: true,
      });
    };

    // The popup is added to the DOM by MapLibre, a beat after this effect runs,
    // so it is waited for rather than assumed. A handful of frames, then the
    // marker is centred on its own — a popup that never arrives must not leave
    // the camera parked where the tap found it.
    let ro: ResizeObserver | undefined;
    let raf = 0;
    let waited = 0;
    const attach = () => {
      const popupEl = mapInst.getContainer().querySelector<HTMLElement>(".maplibregl-popup");
      const card = popupEl?.querySelector<HTMLElement>(".maplibregl-popup-content");
      if (!card) {
        if (waited++ < 10) raf = requestAnimationFrame(attach);
        else place();
        return;
      }
      const tip = popupEl?.querySelector<HTMLElement>(".maplibregl-popup-tip") ?? undefined;
      // Fires once on observe with the size it has now, and again on every
      // change — the initial placement and the re-fits are the same code path.
      ro = new ResizeObserver(() => place(card, tip));
      ro.observe(card);
    };
    raf = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  });

  function emitView(userInitiated: boolean) {
    if (!onViewChange || !map) return;
    const c = map.getCenter();
    const b = map.getBounds();
    const ne = b.getNorthEast();
    const sw = b.getSouthWest();
    onViewChange(
      {
        lat: c.lat,
        lon: c.lng,
        radiusM: c.distanceTo(ne),
        bounds: [
          [sw.lat, sw.lng],
          [ne.lat, ne.lng],
        ],
      },
      userInitiated,
    );
  }

  function handleLoad() {
    isLoaded = true;
    map?.touchZoomRotate.disableRotation();
    doRecenter();
    // After `doRecenter`, so the pen is measured around the view the map
    // actually settled on.
    applyViewLock();
    trackZoomLimits();
    // The controls exist now; the visible area is measured before they do.
    measureVisible?.();
    emitView(false);
    const attrEl = map?.getContainer().querySelector(".maplibregl-ctrl-attrib");
    attrEl?.classList.remove("maplibregl-compact-show");
    if (hidePlaceLabels && map) {
      for (const layer of map.getStyle().layers) {
        if (
          layer.type === "symbol" &&
          "source-layer" in layer &&
          layer["source-layer"] === "place"
        ) {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      }
    }
    signalIfDrawn();
  }

  // The label pop (`marker-pop-label`, globals.css) is a CSS animation that
  // runs when its class lands, so the class is put on each label — and the
  // start flag — as the element is created rather than written in the markup.
  // A label's first appearance pops only under `popInOnLoad`; every later one
  // does, and a `popKey` change is exactly that, since the key block rebuilds
  // the element. Keyed by `data-pop-id` read off the element, so the
  // attachment is one stable function that never re-runs on a marker update.
  // Not a `SvelteSet`, on purpose: read inside the attachment, a reactive set
  // would re-run every label's `popIn` whenever one label was added to it —
  // and popping all of them again is exactly what this exists to prevent.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const shownLabels = new Set<string>();
  const popIn: Attachment<HTMLElement> = (el) => {
    const id = el.dataset.popId ?? "";
    const firstShown = !shownLabels.has(id);
    shownLabels.add(id);
    if (!firstShown || untrack(() => popInOnLoad)) el.classList.add("marker-pop-label");
  };

  function handleClick(ev: maplibregl.MapMouseEvent) {
    if (!map || !interactive) return;
    const feats = map.queryRenderedFeatures(ev.point, { layers: [MARKERS_LAYER] });
    const f = feats[0];
    if (f) {
      const mid = f.properties?.mid as string | undefined;
      const m = mid != null ? markerById.get(mid) : undefined;
      if (m && markerPopup && !m.noPopup) selected = mid ?? null;
      else m?.onClick?.();
      return;
    }
    selected = null;
  }

  function setCursor(v: string) {
    const c = map?.getCanvas();
    if (c) c.style.cursor = v;
  }
</script>

<div
  bind:this={root}
  class="map-view-root {className}"
  style="position: relative; height: 100%; width: 100%;"
>
  {#if showError}
    <div
      style="position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem; padding: 1.5rem; text-align: center; background: #0E85C6; color: #fff;"
    >
      <svg
        style="width: 2.25rem; height: 2.25rem;"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="1.75"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M12 9v3.75m0 3.75h.008M10.34 3.94l-8.4 14.55A1.5 1.5 0 003.24 21h17.52a1.5 1.5 0 001.3-2.51L13.66 3.94a1.5 1.5 0 00-2.6 0z"
        />
      </svg>
      <p style="margin: 0; font-weight: 700; font-size: 0.95rem;">Map couldn't load</p>
      <p style="margin: 0; font-size: 0.8rem; opacity: 0.85;">
        Check your connection and try again.
      </p>
    </div>
  {/if}
  <!-- The part of the box the map is seen through. A page that paints
       something over one side of the map (the landing hero: copy over the
       right half on wide screens, over the top on narrow ones) declares the
       covered strips as custom properties on any ancestor —
       `--map-view-inset-top/right/bottom/left`, any CSS length — and this
       element takes the shape of what is left. Sized in CSS rather than by
       reading the properties from script so the page can write them in
       whatever unit fits (a percentage, a `calc()` against one of its own
       variables) and the browser does the resolving; the observer in the
       script reads the result in px (`visibleInset`). Never painted, never
       hit-tested. -->
  <div bind:this={visibleEl} class="map-view-visible" aria-hidden="true"></div>
  <!-- Fully opaque throughout, and deliberately not faded in. The map used to
       rise from opacity 0 while a loading panel sat on top of it, which is a
       cross-fade rather than a reveal: for its whole length both layers were
       part transparent, so the map dimmed on its way in instead of simply being
       uncovered. Nothing is lost by leaving it solid — until `MapFrame`'s
       overlay clears, this is hidden behind it — and it keeps a live WebGL
       canvas out of a composited opacity animation. -->
  <MapLibre
    bind:map
    style={mapStyle}
    inlineStyle="height: 100%; width: 100%;"
    autoloadGlobalCss={false}
    attributionControl={false}
    center={[center[1], center[0]]}
    {zoom}
    minZoom={zoomFloor}
    maxBounds={openingBounds}
    {maxZoom}
    dragPan={interactive}
    dragRotate={false}
    pitchWithRotate={false}
    touchPitch={false}
    scrollZoom={wheelZoom}
    {cooperativeGestures}
    doubleClickZoom={interactive}
    touchZoomRotate={interactive}
    boxZoom={interactive}
    keyboard={interactive}
    onload={handleLoad}
    onzoom={trackZoomLimits}
    onidle={signalIfIdle}
    onerror={handleError}
    onclick={handleClick}
    onmoveend={(ev) => emitView(!!(ev as { originalEvent?: unknown }).originalEvent)}
  >
    <AttributionControl customAttribution={ATTRIBUTION} compact />

    {#if cooperativeGestures}
      <!-- View controls in place of MapLibre's flashing screen: with the wheel
           handed to the page, these are the visible way to move the map.
           Bottom-left is lifted clear of anything the page lays over the map's
           lower edge by `--map-ctrl-inset-bottom`. -->
      <CustomControl position="bottom-left" group={false} class="view-controls">
        <div class="maplibregl-ctrl-group">
          <button
            type="button"
            class="view-controls__reset"
            title="Reset view"
            aria-label="Reset view"
            disabled={!interactive}
            onclick={resetView}
          >
            <ArrowCounterClockwise size={18} weight="bold" aria-hidden="true" />
          </button>
        </div>
        <div class="maplibregl-ctrl-group">
          <button
            type="button"
            class="maplibregl-ctrl-zoom-out"
            title="Zoom out"
            aria-label="Zoom out"
            disabled={!interactive || atMinZoom}
            onclick={() => map?.zoomOut({ around: visibleCentre(), duration: motionMs(300) })}
          >
            <span class="maplibregl-ctrl-icon" aria-hidden="true"></span>
          </button>
          <button
            type="button"
            class="maplibregl-ctrl-zoom-in"
            title="Zoom in"
            aria-label="Zoom in"
            disabled={!interactive || atMaxZoom}
            onclick={() => map?.zoomIn({ around: visibleCentre(), duration: motionMs(300) })}
          >
            <span class="maplibregl-ctrl-icon" aria-hidden="true"></span>
          </button>
        </div>
      </CustomControl>
    {/if}

    {#if showFullscreen}
      <FullScreenControl position="top-right" />
    {/if}

    {#if showLocate}
      <GeolocateControl
        position="top-right"
        positionOptions={{ enableHighAccuracy: true }}
        trackUserLocation
        showAccuracyCircle
        showUserLocation
        showUserHeading
      />
    {/if}

    {#if lineData}
      <GeoJSONSource id={LINE_SOURCE} data={lineData} lineMetrics={lineProgress !== undefined}>
        {#if lineUpcoming}
          <!-- Listed first, so it is added first and the drawn line paints
               over it wherever the two overlap. Faint, not dashed: a loading
               frame drawn without the engine can match a solid line exactly,
               but not where MapLibre's dashes fall, and the two would visibly
               shift at the hand-off. -->
          <LineLayer layout={LINE_LAYOUT} paint={UPCOMING_PAINT} />
        {/if}
        <LineLayer id={LINE_LAYER} layout={LINE_LAYOUT} paint={linePaint} />
      </GeoJSONSource>
    {/if}

    <!-- `promoteId` makes each feature's id its `mid`, which is what
         `setFeatureState` addresses a pulse to. -->
    <GeoJSONSource id={MARKERS_SOURCE} data={markerData} promoteId="mid">
      {#if pulses}
        <CircleLayer id={PULSE_LAYER} paint={pulsePaint(markerRadius)} />
      {/if}
      <CircleLayer
        id={MARKERS_LAYER}
        paint={{
          "circle-radius": radius,
          "circle-color": ["case", ["get", "dimmed"], "#9ca3af", ["get", "color"]],
          "circle-opacity": ["case", ["get", "dimmed"], 0.45, 1],
          "circle-stroke-width": strokeW,
          "circle-stroke-color": "#fff",
          "circle-stroke-opacity": ["case", ["get", "dimmed"], 0.45, 1],
        }}
        onmouseenter={() => interactive && setCursor("pointer")}
        onmouseleave={() => setCursor("")}
      />
    </GeoJSONSource>

    {#if runnerData}
      <!-- Mounted after the markers so `beforeId` has a layer to slot in
           front of: under the stops' dots, over their pulse rings. -->
      <GeoJSONSource id={RUNNER_SOURCE} data={runnerData}>
        <CircleLayer id={RUNNER_LAYER} beforeId={MARKERS_LAYER} paint={RUNNER_PAINT} />
      </GeoJSONSource>
    {/if}

    {#each labeled as m (m.id)}
      <Marker lnglat={[m.lon, m.lat]} style={{ pointerEvents: "none" }}>
        {#snippet content()}
          <!-- Keyed so a caller can replay the pop by changing `popKey`: the
               element is rebuilt, and `popIn` pops it. -->
          {#key m.popKey}
            <span
              data-pop-id="marker:{m.id}"
              {@attach popIn}
              style="color:#fff; font-size:11px; font-weight:700; line-height:1; opacity:{m.dimmed
                ? 0.45
                : 1}; text-shadow:0 1px 1px rgba(0,0,0,.35);"
            >
              {m.label}
            </span>
          {/key}
        {/snippet}
      </Marker>
    {/each}

    {#if beckonMarker}
      <!-- Mounted after the labels, so drawn over them: the wave is masked
           clear of the dot and its label (see `Beckon`). -->
      <Marker lnglat={[beckonMarker.lon, beckonMarker.lat]} style={{ pointerEvents: "none" }}>
        {#snippet content()}
          <Beckon
            color={ROUTE_LINE.color}
            dotR={markerRadius + MARKER_STROKE_PX}
            reachPx={BECKON_REACH_PX}
            since={beckonSince}
          />
        {/snippet}
      </Marker>
    {/if}

    {#if start}
      <!-- Anchored at its centre by the marker, then shifted so the base of
           the pole is on the point (see `START_FLAG.pole`). -->
      <Marker lnglat={[start[1], start[0]]} style={{ pointerEvents: "none" }}>
        {#snippet content()}
          <span
            class="start-flag"
            data-pop-id="start"
            {@attach popIn}
            style="--flag-color: {START_FLAG.color}; --flag-dx: {START_FLAG.px *
              (0.5 - START_FLAG.pole.x)}px; --flag-dy: {START_FLAG.px *
              (0.5 - START_FLAG.pole.y)}px;"
            aria-hidden="true"
          >
            <FlagIcon size={START_FLAG.px} weight="fill" />
          </span>
        {/snippet}
      </Marker>
    {/if}

    {#if selectedMarker && markerPopup && !selectedMarker.noPopup}
      <!-- Keyed on the side the card opens on, because `anchor` is a
        construction-time option: `svelte-maplibre-gl` passes it into
        `new maplibregl.Popup(...)` once and never again (there is no setter to
        pass it to), so a plain prop change is silently dropped and every popup
        after the first keeps the first one's side — the map's own popup
        instance is reused as the selection moves from marker to marker. The
        key makes the side a real change: a new Popup, built with it.
        `selected` is in the key too, so a fresh marker also gets a fresh pop-in
        rather than the card sliding across the map. -->
      {#key `${selected}:${popupAnchor}`}
        <!-- `focusAfterOpen={false}`: MapLibre otherwise focuses the popup's
          first focusable element the moment it opens (its default), which drops
          a focus ring on the first action button of a popup the visitor just
          tapped. The card opens under the pointer and is already where they are
          looking, so the move buys nothing and the ring reads as a stray
          selection. Tab order still reaches the card — it is in the DOM after
          the markers. -->
        <Popup
          lnglat={[selectedMarker.lon, selectedMarker.lat]}
          anchor={popupAnchor}
          offset={POPUP_OFFSET_PX}
          closeOnClick={false}
          closeButton={false}
          maxWidth="none"
          focusAfterOpen={false}
          onclose={() => (selected = null)}
        >
          {@render markerPopup(selectedMarker)}
        </Popup>
      {/key}
    {/if}
  </MapLibre>
</div>

<style>
  /* Rounds the map to the corner of the frame it sits in.
     The symptom this exists for: the frame's corners look right for the first
     couple of seconds and then square off. That is not the corner changing —
     it is `MapFrame` removing its loading overlay. The overlay's paper and
     glass are ordinary painted content, they round on their own, and while
     they are up they cover the canvas. What is underneath was never rounded.

     A WebGL canvas is composited on its own layer, and a layer is not clipped
     by an ancestor's `border-radius` + `overflow` — the compositor needs a
     clip it can apply itself. So the rounding is stated twice, on purpose:

     - `clip-path` on this element, which the compositor applies to the whole
       subtree, canvas included. This is the one that does the work.
     - `border-radius` directly on the canvas and its container, as the
       fallback for anything that ignores the first.

     Both read `--map-frame-radius` straight rather than chaining through
     `border-radius: inherit`. A custom property crosses `<astro-island>` and
     any wrapper between here and the canvas; an `inherit` chain silently
     resolves to 0 the moment one link doesn't opt in. The fallback value keeps
     a map used outside a frame square. */
  .map-view-root {
    border-radius: var(--map-frame-radius, 0);
    overflow: hidden;
    clip-path: inset(0 round var(--map-frame-radius, 0));
  }

  .map-view-root :global(.maplibregl-map),
  .map-view-root :global(.maplibregl-canvas-container),
  .map-view-root :global(.maplibregl-canvas) {
    border-radius: var(--map-frame-radius, 0);
  }

  /* Lifts the bottom-corner controls (attribution) clear of anything a page
     lays over the map's lower edge — the landing hero runs its map under the
     next section's wave, and the credit must not go under with it. A custom
     property rather than a prop: like `--map-frame-radius`, it has to cross
     the `<astro-island>` boundary from the page that knows the overlap. */
  .map-view-root :global(.maplibregl-ctrl-bottom-left),
  .map-view-root :global(.maplibregl-ctrl-bottom-right) {
    bottom: var(--map-ctrl-inset-bottom, 0);
  }

  .map-view-visible {
    position: absolute;
    top: var(--map-view-inset-top, 0);
    right: var(--map-view-inset-right, 0);
    bottom: var(--map-view-inset-bottom, 0);
    left: var(--map-view-inset-left, 0);
    visibility: hidden;
    pointer-events: none;
  }

  /* The start flag: the glyph in its own green, haloed in white like the
     stops' rings so it reads against any ground. The shift puts the pole's
     base on the point; `transform-origin` keeps the pop-in growing from it. */
  .start-flag {
    display: block;
    color: var(--flag-color);
    translate: var(--flag-dx) var(--flag-dy);
    transform-origin: calc(50% - var(--flag-dx)) calc(50% - var(--flag-dy));
    filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 1px #fff)
      drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
  }

  /* MapLibre's cooperative-gestures screen: a 40% black wash with a message,
     thrown over the whole map for a second on every wheel tick that arrives
     without the modifier. On a map that is the page's hero that is the hero
     going dark every time the visitor scrolls past it. Hidden outright; the
     handler still does its job (page scrolls, map does not), and the view
     controls in the corner are the way to move the map instead. */
  .map-view-root :global(.maplibregl-cooperative-gesture-screen) {
    display: none;
  }

  /* Two pills stacked, flush left: the reset on its own above, the zoom pair
     joined side by side below. The control itself is not a group
     (`group={false}`) — the pills inside carry MapLibre's group class, so
     each gets its own paper and shadow. MapLibre draws the seam between
     buttons on the top edge for its stacked groups; in the zoom row the seam
     goes on the left instead, same colour as its own (`#ddd`). */
  .map-view-root :global(.view-controls) {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .map-view-root :global(.view-controls .maplibregl-ctrl-group) {
    display: flex;
  }

  .map-view-root :global(.view-controls button + button) {
    border-top: 0;
    border-left: 1px solid #ddd;
  }

  /* The reset button carries an inline SVG where MapLibre's own buttons carry
     a background-image span, so it centres its glyph itself. Colour matches
     the fill MapLibre paints its zoom glyphs in. */
  .map-view-root :global(.view-controls__reset) {
    display: grid;
    place-items: center;
    color: #333;
  }
</style>
