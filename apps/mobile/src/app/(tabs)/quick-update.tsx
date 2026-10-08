import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { useIsFocused } from "expo-router";
import { WarningIcon } from "phosphor-react-native/src/icons/Warning";
import { SafeArea } from "../../components/ui/SafeArea";
import type { Fountain, EditExtras } from "@water-run/core/schemas";
import type { StopStatus } from "@water-run/core/stores/run";
import {
  milesToMeters,
  haversine,
  boundsCenter,
  boundsRadiusM,
  MAX_SEARCH_RADIUS_M,
  type Pt,
} from "@water-run/core/geo";
import { callApi, postJson } from "@water-run/core/apiCall";
import { useOutbox } from "@water-run/core/stores/outbox";
import { EDIT_COLOR, EDIT_LABEL } from "@water-run/core/editStatus";
import { fountainDotStyle } from "@water-run/core/fountainFilters";
import { shouldRefineSearch } from "@water-run/core/locate";
import { zoomToCover } from "@water-run/core/mapFrame";
import { loadNearbyCenter, saveNearbyCenter } from "@water-run/core/nearbyView";
import { locateFast } from "../../ports/locateFast";
import { celebratePoint } from "../../ports/confetti";
import { hapticSuccess } from "../../ports/haptics";
import { PointSheetHost } from "../../components/ui/PointSheetHost";
import { WaterRunMap, type MapMarker, type MapRegion } from "../../map/WaterRunMap";
import { PointSheet, type PointEdit, type SurveyAction } from "../../components/PointSheet";

const TAG = { key: "amenity", value: "drinking_water" };
// How far around the user the search from a fix reaches. The map zooms so
// that the search reaches its corners (see zoomToCover).
const RADIUS_MI = 1;
const RADIUS_M = milesToMeters(RADIUS_MI);
// A ceiling against a dead connection, not a budget: past it a search gives up
// with an error that offers to try again, instead of spinning forever. Above
// the server's own upstream limits, as the planner's point search is: a search
// may fall back across Overpass mirrors.
const SEARCH_TIMEOUT_MS = 90_000;
// The map must drift this far past the last search (as a fraction of that
// search's radius) before "Search this area" appears — stops it flickering on
// every idle settle.
const REQUERY_FRACTION = 0.3;
// Where the map opens before there has ever been a search to open on: the
// whole world, as the planner tab shows before its first fix.
const WORLD_CENTER: [number, number] = [20, 0];
const WORLD_ZOOM = 1.5;

type Search = { center: Pt; radiusM: number };
// A search as asked for. Only one made from a location fix is where the map
// opens next time (see nearbyView): a "Search this area" can be anywhere.
type SearchRequest = Search & { fromFix: boolean };

// True once the viewport has panned/zoomed far enough from the last search that
// re-querying would surface different fountains.
function movedEnough(region: MapRegion, last: Search): boolean {
  const c = boundsCenter(region.bounds);
  const r = Math.min(boundsRadiusM(region.bounds), MAX_SEARCH_RADIUS_M);
  const panned = haversine(c, last.center) > last.radiusM * REQUERY_FRACTION;
  const resized = Math.abs(r - last.radiusM) > last.radiusM * REQUERY_FRACTION;
  return panned || resized;
}

// A map from the first frame → locate → show the fountains within a mile → tap one
// → record its state to OSM (offline-first via the outbox). Pan/zoom the map, then
// "Search this area" re-queries the visible viewport — so zooming out searches a
// wider region. No routing.
export default function QuickUpdate() {
  // Snapshot the clock once for the dot recency coloring — it needn't tick live.
  const [now] = useState(() => Date.now());
  // The map's size, which the zoom is fitted to. The map fills this screen,
  // so it is the screen's as laid out, and the window's until then (on iOS the
  // same; on Android the screen ends above the tab bar).
  const windowSize = useWindowDimensions();
  const [laidOut, setLaidOut] = useState<{ width: number; height: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setLaidOut({ width, height });
  };
  const size = laidOut ?? windowSize;
  // Where the map opens, and where each recenter moves it, zoomed so the
  // search around it reaches the corners. The map is drawn at once, long
  // before a fix can arrive, so it opens where the last search from a fix was
  // made (read synchronously, so the first frame already has it), or on the
  // whole world before there has been one. The first fix then moves it.
  const [center, setCenter] = useState<Pt | null>(() => loadNearbyCenter());
  const mapCenter: [number, number] = center ? [center.lat, center.lon] : WORLD_CENTER;
  const zoom = center ? zoomToCover(RADIUS_M, center.lat, size) : WORLD_ZOOM;
  const [fountains, setFountains] = useState<Fountain[]>([]);
  // Track the tapped point by id, not the resolved object — the sheet opens the
  // instant this is set (before the fountain is looked up), so it never waits on
  // content. `selected` is derived; a null derive shows the sheet's spinner.
  const [selectedId, setSelectedId] = useState<MapMarker["id"] | null>(null);
  // Points updated this session, keyed by node id, derived from the outbox so
  // the sheet can show the recorded state + live sync status.
  const outboxItems = useOutbox((s) => s.items);
  const edits = useMemo(() => {
    const m: Record<number, PointEdit> = {};
    for (const it of outboxItems) {
      m[it.nodeId] = {
        status: it.action,
        syncState: it.syncState,
        changesetUrl: it.changesetUrl,
        extras: it.extras,
      };
    }
    return m;
  }, [outboxItems]);
  // A search is in flight. Locating is tracked apart (`locate`); neither
  // holds the map back, each only shows in the status pill over it.
  const [busy, setBusy] = useState(false);
  const [locate, setLocate] = useState<"locating" | "located" | "failed">("locating");
  // What last went wrong, shown over the map. A search that failed for a
  // reason that can pass (no connection, a slow or busy server) keeps its
  // request, so the banner can run it again; a refused search, or a failed
  // locate, has none.
  const [err, setErr] = useState<{ message: string; retry: SearchRequest | null } | null>(null);
  // Where/how wide the current markers were fetched, and the live viewport.
  const [lastSearch, setLastSearch] = useState<Search | null>(null);
  const [region, setRegion] = useState<MapRegion | null>(null);
  // Bumped to move the map to `center`: on the first fix, and when a fresh
  // fix corrects it.
  const [recenterKey, setRecenterKey] = useState(0);
  // The map only draws the device's location while this tab is on screen,
  // and only once a fix has arrived: before that, location may not be
  // permitted yet, and MapLibre's own location layer could ask for it,
  // racing expo-location's prompt.
  const isFocused = useIsFocused();

  // Only the latest search may show its results: the search made from a
  // fresh fix can overlap the one made from the first.
  const searchSeq = useRef(0);
  const search = useCallback(async (req: SearchRequest) => {
    const { center: c, radiusM, fromFix } = req;
    // The server refuses a wider search; "Search this area" isn't offered for
    // one (see tooWide), so this only guards.
    const capped = Math.min(radiusM, MAX_SEARCH_RADIUS_M);
    const seq = ++searchSeq.current;
    setBusy(true);
    setErr(null);
    setSelectedId(null);
    try {
      // callApi words a failure for the user (offline, too slow, a reply that
      // isn't ours) instead of passing on the platform's own error text.
      const reply = await callApi<{ fountains?: Fountain[] }>(
        "/api/fountains",
        postJson({
          lat: c.lat,
          lon: c.lon,
          radiusM: capped,
          tag: TAG,
          recencyMode: "any",
          includeDisused: true,
        }),
        SEARCH_TIMEOUT_MS,
        "Couldn't load fountains.",
      );
      if (seq !== searchSeq.current) return;
      if (!reply.ok) {
        setErr({ message: reply.message, retry: reply.retryable ? req : null });
        return;
      }
      setFountains(reply.data.fountains ?? []);
      setLastSearch({ center: c, radiusM: capped });
      if (fromFix) saveNearbyCenter(c);
    } catch (e) {
      // callApi only rejects for a bug, not for the network: trying again
      // wouldn't help.
      if (seq === searchSeq.current) {
        setErr({ message: e instanceof Error ? e.message : String(e), retry: null });
      }
    } finally {
      if (seq === searchSeq.current) setBusy(false);
    }
  }, []);

  // Moves the map to `pos`, zoomed to the search around it. The viewport the
  // user last settled on goes with it: the map no longer shows it, and kept,
  // it would offer "Search this area" over the fresh results.
  const moveTo = useCallback((pos: Pt) => {
    setCenter(pos);
    setRegion(null);
    setRecenterKey((k) => k + 1);
  }, []);

  // Once the user has moved the map or opened a point, they are using what's
  // on screen, and a later fix no longer moves the map or redoes the search
  // under them. A move counts from the moment it starts: `region` only
  // arrives once the map settles, after any fling, and a fix landing before
  // then would recenter the map in the middle of the gesture.
  const userActed = useRef(false);
  const onUserMove = () => {
    userActed.current = true;
  };
  useEffect(() => {
    if (region != null || selectedId != null) userActed.current = true;
  }, [region, selectedId]);

  // Locate while the map is already up: the phone's recent fix, when it has
  // one, comes at once, and a fresh GPS fix follows. The first fix searches
  // around it and always brings the map to it, even if the user has moved
  // it: until then the map only showed a stand-in for their position (where
  // the last search was made, or the whole world), and a view left there
  // could strand them far from their own results with no way back. That move
  // is a jump (see animateRecenter below). A later fix redoes both only if it
  // lands far enough away to change what's found, and the user hasn't taken
  // the map.
  useEffect(() => {
    let searchedFrom: Pt | null = null;
    return locateFast(
      ({ pos }) => {
        if (searchedFrom) {
          const refine = shouldRefineSearch({
            searchedFrom,
            radiusM: RADIUS_M,
            fresh: pos,
            fraction: REQUERY_FRACTION,
            userActed: userActed.current,
          });
          if (!refine) return;
        } else {
          setLocate("located");
        }
        searchedFrom = pos;
        moveTo(pos);
        void search({ center: pos, radiusM: RADIUS_M, fromFix: true });
      },
      (e) => {
        setErr({ message: e instanceof Error ? e.message : String(e), retry: null });
        setLocate("failed");
      },
    );
  }, [search, moveTo]);

  // Offer a re-query only once the map has moved meaningfully from the results.
  // With no results yet, once locating has settled (failed, or found the user
  // but the search from there failed), any move offers it: the tab stays usable
  // without location or a first search. Not while still locating, though, as
  // the first fix's own search would then replace what the user searched.
  const canRequery =
    !busy &&
    region != null &&
    (lastSearch ? movedEnough(region, lastSearch) : locate !== "locating");
  // A view whose corners lie past the server's limit can't be searched whole,
  // and searching only its middle would read as an empty area: it is offered
  // as a hint to zoom in instead.
  const tooWide = region != null && boundsRadiusM(region.bounds) > MAX_SEARCH_RADIUS_M;

  async function requery() {
    if (!region) return;
    // search() drives `busy`, which swaps this pill for the "Finding fountains"
    // status during the fetch.
    await search({
      center: boundsCenter(region.bounds),
      radiusM: boundsRadiusM(region.bounds),
      fromFix: false,
    });
  }

  // What the map is waiting on, if anything, for the status pill over it.
  const status = busy
    ? { label: "Finding fountains nearby", text: "Finding fountains nearby…" }
    : locate === "locating"
      ? { label: "Locating you", text: "Locating you…" }
      : null;
  const retry = err?.retry;

  // Record a status update to the offline outbox. Keeps the sheet open so it can
  // flip to the recorded-state view (with sync status), matching the web popup.
  function record(node: Fountain, action: SurveyAction, extras?: EditExtras) {
    useOutbox
      .getState()
      .enqueue({ nodeId: node.id, action, tagKey: TAG.key, name: node.tags?.name, extras });
    celebratePoint();
    hapticSuccess();
    useOutbox.getState().flush();
  }

  // Memoized so an unrelated re-render doesn't rebuild the whole array and
  // re-diff the GeoJSON source to the native map. Only recomputes when the
  // inputs that actually affect a dot change.
  const markers: MapMarker[] = useMemo(
    () =>
      fountains.map((f) => {
        const edit = edits[f.id];
        const status = edit?.status as StopStatus | undefined;
        // Unedited dots encode survey recency (green→orange→red, gray for
        // recently-confirmed out-of-service). A recorded edit or the active
        // selection overrides that with its own solid color.
        const recency = fountainDotStyle(f.tags, now);
        return {
          id: f.id,
          lat: f.lat,
          lon: f.lon,
          color: status
            ? (EDIT_COLOR[status] ?? "#16a34a")
            : selectedId === f.id
              ? "#2563eb"
              : recency.color,
          opacity: status || selectedId === f.id ? 1 : recency.opacity,
          label: status ? EDIT_LABEL[status] : undefined,
        };
      }),
    [fountains, edits, selectedId, now],
  );

  // Resolve the tapped id to its fountain. Null while nothing is selected — and,
  // in principle, during any window where the id isn't in `fountains` yet — which
  // is when the sheet shows its spinner instead of PointSheet.
  const selected = useMemo(
    () => (selectedId == null ? null : (fountains.find((f) => f.id === selectedId) ?? null)),
    [fountains, selectedId],
  );

  return (
    <View className="bg-surface flex-1" onLayout={onLayout}>
      <WaterRunMap
        center={mapCenter}
        zoom={zoom}
        markers={markers}
        showUserLocation={isFocused && locate === "located"}
        recenterKey={String(recenterKey)}
        // The first fix's move (key 1) jumps; later ones ease. An ease can be
        // stopped partway by any touch, and the map doesn't say when one is,
        // so the move off the stand-in view, which may come mid-gesture, must
        // land whole. A later one only runs while the user hasn't touched the
        // map, and moves it a short way.
        animateRecenter={recenterKey > 1}
        onRegionChange={setRegion}
        onUserMove={onUserMove}
        onMarkerPress={setSelectedId}
      />

      {/* Across the top of the map, stacked so they never overlap: what it is
          waiting on, what went wrong, and the offer to search where it now is
          (see canRequery). Touches around them go through to the map. */}
      <SafeArea
        edges={["top"]}
        pointerEvents="box-none"
        className="absolute top-0 right-0 left-0 items-center gap-2 p-3"
      >
        {/* A pill, not a scrim: the map stays usable while locating and
            searching. Animated indicator (not static text) so the wait reads
            as in-progress, per Apple HIG. */}
        {status ? (
          <View
            pointerEvents="none"
            className="bg-base flex-row items-center gap-3 rounded-full px-6 py-3 shadow-xl"
            accessibilityRole="progressbar"
            accessibilityLabel={status.label}
          >
            <ActivityIndicator size="small" color="#f7f2e8" />
            <Text className="text-surface text-sm font-semibold">{status.text}</Text>
          </View>
        ) : null}

        {/* A failed search's banner runs it again. A failed locate's only has
            its message (no `disabled`, which would read it out as dimmed). */}
        {err && !busy ? (
          <Pressable
            onPress={retry ? () => void search(retry) : undefined}
            className="bg-base flex-row items-center gap-3 rounded-2xl px-5 py-3 shadow-xl"
            accessibilityRole={retry ? "button" : "alert"}
          >
            <WarningIcon size={18} color="#f87171" weight="bold" />
            <View className="shrink">
              <Text className="text-surface text-sm font-semibold">{err.message}</Text>
              {retry ? <Text className="text-light-muted text-sm">Tap to try again.</Text> : null}
            </View>
          </Pressable>
        ) : null}

        {selectedId == null && canRequery ? (
          tooWide ? (
            <View
              pointerEvents="none"
              className="bg-base rounded-full px-5 py-2.5 shadow-lg"
              accessibilityRole="text"
            >
              <Text className="text-surface font-semibold">Zoom in to search this area</Text>
            </View>
          ) : (
            <Pressable
              onPress={requery}
              className="bg-link flex-row items-center gap-2 rounded-full px-5 py-2.5 shadow-lg"
              accessibilityRole="button"
            >
              <Text className="font-semibold text-white">Search this area</Text>
            </Pressable>
          )
        ) : null}
      </SafeArea>

      {/* Native OS bottom sheet (SwiftUI / Jetpack Compose via @expo/ui). The
          gesture + spring run off the JS thread; PointSheet stays plain RN.
          PointSheetHost owns the sizing workaround and the keyboard. */}
      <PointSheetHost isPresented={selectedId != null} onDismiss={() => setSelectedId(null)}>
        {selected ? (
          <PointSheet
            fountain={selected}
            edit={edits[selected.id]}
            onAction={(action, extras) => record(selected, action, extras)}
          />
        ) : (
          // Sheet opened instantly on tap; spin until the point resolves.
          <View className="items-center justify-center py-12">
            <ActivityIndicator />
          </View>
        )}
      </PointSheetHost>
    </View>
  );
}
