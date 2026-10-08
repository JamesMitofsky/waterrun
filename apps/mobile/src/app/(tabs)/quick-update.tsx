import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useIsFocused } from "expo-router";
import { SafeArea } from "../../components/ui/SafeArea";
import type { Fountain, EditExtras } from "@rosm/core/schemas";
import type { StopStatus } from "@rosm/core/stores/run";
import { milesToMeters, haversine, boundsCenter, boundsRadiusM, type Pt } from "@rosm/core/geo";
import { useOutbox } from "@rosm/core/stores/outbox";
import { EDIT_COLOR, EDIT_LABEL } from "@rosm/core/editStatus";
import { fountainDotStyle } from "@rosm/core/fountainFilters";
import { shouldRefineSearch } from "@rosm/core/locate";
import { api } from "../../ports/api";
import { locateFast } from "../../ports/locateFast";
import { celebratePoint } from "../../ports/confetti";
import { hapticSuccess } from "../../ports/haptics";
import { PointSheetHost } from "../../components/ui/PointSheetHost";
import { RosmMap, type RosmMarker, type RosmRegion } from "../../map/RosmMap";
import { PointSheet, type PointEdit, type SurveyAction } from "../../components/PointSheet";

const TAG = { key: "amenity", value: "drinking_water" };
const RADIUS_MI = 0.3;
// Cap the queried area so a fully zoomed-out map can't fire a huge Overpass query.
const MAX_RADIUS_M = milesToMeters(25);
// The map must drift this far past the last search (as a fraction of that
// search's radius) before "Search this area" appears — stops it flickering on
// every idle settle.
const REQUERY_FRACTION = 0.3;

type Search = { center: Pt; radiusM: number };

// True once the viewport has panned/zoomed far enough from the last search that
// re-querying would surface different fountains.
function movedEnough(region: RosmRegion, last: Search): boolean {
  const c = boundsCenter(region.bounds);
  const r = Math.min(boundsRadiusM(region.bounds), MAX_RADIUS_M);
  const panned = haversine(c, last.center) > last.radiusM * REQUERY_FRACTION;
  const resized = Math.abs(r - last.radiusM) > last.radiusM * REQUERY_FRACTION;
  return panned || resized;
}

// Locate → show nearby fountains → tap one → record its state to OSM (offline-first
// via the outbox). Pan/zoom the map, then "Search this area" re-queries the visible
// viewport — so zooming out searches a wider region. No routing.
export default function QuickUpdate() {
  // Snapshot the clock once for the dot recency coloring — it needn't tick live.
  const [now] = useState(() => Date.now());
  const [center, setCenter] = useState<Pt | null>(null);
  const [fountains, setFountains] = useState<Fountain[]>([]);
  // Track the tapped point by id, not the resolved object — the sheet opens the
  // instant this is set (before the fountain is looked up), so it never waits on
  // content. `selected` is derived; a null derive shows the sheet's spinner.
  const [selectedId, setSelectedId] = useState<RosmMarker["id"] | null>(null);
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
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Where/how wide the current markers were fetched, and the live viewport.
  const [lastSearch, setLastSearch] = useState<Search | null>(null);
  const [region, setRegion] = useState<RosmRegion | null>(null);
  // Bumped to move the map to `center` when a fresh fix corrects the first one.
  const [recenterKey, setRecenterKey] = useState(0);
  // The map only draws the device's location while this tab is on screen.
  const isFocused = useIsFocused();

  // Only the latest search may show its results: the search made from a
  // fresh fix can overlap the one made from the first.
  const searchSeq = useRef(0);
  const search = useCallback(async ({ center: c, radiusM }: Search) => {
    const capped = Math.min(radiusM, MAX_RADIUS_M);
    const seq = ++searchSeq.current;
    setBusy(true);
    setErr(null);
    setSelectedId(null);
    try {
      const r = await api.apiFetch("/api/fountains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: c.lat,
          lon: c.lon,
          radiusM: capped,
          tag: TAG,
          recencyMode: "any",
          includeDisused: true,
        }),
      });
      const j = await r.json();
      if (seq !== searchSeq.current) return;
      if (!r.ok) throw new Error(j.error?.message ?? "Couldn't load fountains.");
      setFountains(j.fountains as Fountain[]);
      setLastSearch({ center: c, radiusM: capped });
    } catch (e) {
      if (seq === searchSeq.current) setErr((e as Error).message);
    } finally {
      if (seq === searchSeq.current) setBusy(false);
    }
  }, []);

  // Once the user has moved the map or opened a point, they are using what's
  // on screen, and a fresh fix no longer redoes the search under them. A move
  // counts from the moment it starts: `region` only arrives once the map
  // settles, after any fling, and a fix landing before then would recenter
  // the map in the middle of the gesture.
  const userActed = useRef(false);
  const onUserMove = () => {
    userActed.current = true;
  };
  useEffect(() => {
    if (region != null || selectedId != null) userActed.current = true;
  }, [region, selectedId]);

  // Open on the phone's recent fix at once, rather than a spinner for the
  // whole GPS wait, and search there. The fresh fix then redoes the search
  // only if it lands far enough away to change what's found.
  useEffect(() => {
    const radiusM = milesToMeters(RADIUS_MI);
    let searchedFrom: Pt | null = null;
    return locateFast(
      ({ pos }) => {
        if (searchedFrom) {
          const refine = shouldRefineSearch({
            searchedFrom,
            radiusM,
            fresh: pos,
            fraction: REQUERY_FRACTION,
            userActed: userActed.current,
          });
          if (!refine) return;
          setRecenterKey((k) => k + 1);
        }
        searchedFrom = pos;
        setCenter(pos);
        void search({ center: pos, radiusM });
      },
      (e) => {
        setErr(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  }, [search]);

  // Offer a re-query only once the map has moved meaningfully from the results.
  const canRequery =
    !busy && region != null && lastSearch != null && movedEnough(region, lastSearch);

  async function requery() {
    if (!region) return;
    // search() drives `busy`, which surfaces the top loading pill during the fetch.
    await search({ center: boundsCenter(region.bounds), radiusM: boundsRadiusM(region.bounds) });
  }

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
  const markers: RosmMarker[] = useMemo(
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
    <View className="bg-surface flex-1">
      {center ? (
        <RosmMap
          center={[center.lat, center.lon]}
          markers={markers}
          showUserLocation={isFocused}
          recenterKey={String(recenterKey)}
          animateRecenter
          onRegionChange={setRegion}
          onUserMove={onUserMove}
          onMarkerPress={setSelectedId}
        />
      ) : (
        // Pre-map: geolocation still resolving. Animated indicator (not static
        // text) so the wait reads as in-progress, per Apple HIG.
        <View className="flex-1 items-center justify-center gap-3">
          {err == null ? (
            <>
              <ActivityIndicator accessibilityLabel="Locating you" />
              <Text className="text-muted">Locating you…</Text>
            </>
          ) : (
            <Text className="text-muted">{err}</Text>
          )}
        </View>
      )}

      {/* Full-map overlay while fountain fetch is in flight — covers initial load
          and "Search this area" requeries so the map never reads as frozen. */}
      {center && busy ? (
        <View
          pointerEvents="none"
          className="absolute inset-0 z-10 items-center justify-center bg-black/25"
        >
          <View
            className="bg-base flex-row items-center gap-3 rounded-full px-6 py-3 shadow-xl"
            accessibilityRole="progressbar"
            accessibilityLabel="Finding fountains nearby"
          >
            <ActivityIndicator size="small" color="#f7f2e8" />
            <Text className="text-surface text-sm font-semibold">Finding fountains nearby…</Text>
          </View>
        </View>
      ) : null}

      {/* Top pill: once the map has drifted from the last search, offer a requery. */}
      {center && selectedId == null && canRequery ? (
        <SafeArea edges={["top"]} className="absolute top-0 right-0 left-0 items-center p-3">
          <Pressable
            onPress={requery}
            className="bg-link flex-row items-center gap-2 rounded-full px-5 py-2.5 shadow-lg"
            accessibilityRole="button"
          >
            <Text className="font-semibold text-white">Search this area</Text>
          </Pressable>
        </SafeArea>
      ) : null}

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
