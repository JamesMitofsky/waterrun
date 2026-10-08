import { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, type ViewStyle, type NativeSyntheticEvent } from "react-native";
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  NativeUserLocation,
} from "@maplibre/maplibre-react-native";
import { CrosshairSimpleIcon } from "phosphor-react-native/src/icons/CrosshairSimple";
import type { Feature, FeatureCollection, Point } from "geojson";
import { OSM_STYLE_JSON } from "./style";

// Layer id for the marker dots.
const MARKER_LAYER = "marker-dots";

// Marker data only — screens attach their own action UI on press (Leaflet-style
// popups can't ride through GeoJSON). Mirrors the web MapView marker shape.
export type RosmMarker = {
  id: number | string;
  lat: number;
  lon: number;
  color: string;
  label?: string;
  dimmed?: boolean;
  // Per-dot opacity (0–1). Applies unless `dimmed` forces the faded state.
  opacity?: number;
};

type PressEvent = { lngLat: [number, number]; point: [number, number] };
// Source-level press payload: the features hit under the touch, native-side.
type MarkerPressEvent = { features: Feature[] };
// MapLibre onRegionDidChange payload (subset we use). bounds is [w, s, e, n].
type RegionEvent = {
  center: [number, number]; // [lon, lat]
  zoom: number;
  bounds: [number, number, number, number];
  userInteraction: boolean;
};

// Viewport after the user pans/zooms, in the [lat, lon] convention this map uses.
export type RosmRegion = {
  center: [number, number]; // [lat, lon]
  zoom: number;
  bounds: [number, number, number, number]; // [w, s, e, n]
};

type Props = {
  center: [number, number]; // [lat, lon]
  zoom?: number;
  bearing?: number;
  markers?: RosmMarker[];
  line?: [number, number][]; // [lat, lon][]
  // The device's own location, drawn natively (a blue dot with a heading cone).
  showUserLocation?: boolean;
  // Where the location button takes the map.
  userPos?: [number, number] | null; // [lat, lon]
  onMarkerPress?: (id: RosmMarker["id"]) => void;
  onMapPress?: (lat: number, lon: number) => void;
  // Fires after a user-driven pan/zoom settles (not programmatic camera moves).
  onRegionChange?: (region: RosmRegion) => void;
  // Position the camera once, then leave it under the user's finger. Without this
  // the controlled center/zoom re-applies on every render and snaps panning back.
  initialOnly?: boolean;
  recenterKey?: string;
  fitPoints?: [number, number][]; // [lat, lon][]
  showLocationButton?: boolean;
  style?: ViewStyle;
};

const markerFeatures = (markers: RosmMarker[]): FeatureCollection<Point> => ({
  type: "FeatureCollection",
  features: markers.map((m): Feature<Point> => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [m.lon, m.lat] },
    properties: {
      mid: String(m.id),
      color: m.color,
      label: m.label ?? "",
      dimmed: m.dimmed ? 1 : 0,
      opacity: m.opacity ?? 1,
    },
  })),
});

const lineFeature = (line: [number, number][]): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates: line.map(([lat, lon]) => [lon, lat]) },
  properties: {},
});

// The sources' layers never change, so they are built once. GeoJSONSource is
// memoized, but its children are props too: layers written inline were new
// elements, with new paint objects, on every render, which defeated the memo.
const ROUTE_LAYERS = [
  <Layer
    key="route-line"
    id="route-line"
    type="line"
    beforeId={MARKER_LAYER}
    paint={{ "line-color": "#2563eb", "line-width": 4, "line-opacity": 0.85 }}
  />,
];

const MARKER_LAYERS = [
  <Layer
    key={MARKER_LAYER}
    id={MARKER_LAYER}
    type="circle"
    paint={{
      "circle-color": ["get", "color"],
      "circle-radius": 9,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": ["case", ["==", ["get", "dimmed"], 1], 0.4, ["get", "opacity"]],
    }}
  />,
  <Layer
    key="marker-labels"
    id="marker-labels"
    type="symbol"
    layout={{
      "text-field": ["get", "label"],
      "text-size": 11,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    }}
    paint={{ "text-color": "#ffffff" }}
  />,
];

// Resolve a tapped marker id back to the caller's original type. Marker ids are
// stringified into GeoJSON properties, so a numeric id comes back as a string —
// coerce it so `f.id === id` comparisons on the caller side still match.
const resolveId = (raw: string): RosmMarker["id"] => (/^-?\d+$/.test(raw) ? Number(raw) : raw);

// Center on the fit-points centroid at a modest zoom when a bounding set is given,
// else the explicit center. (A true fitBounds is a later refinement.)
function resolveView(
  center: [number, number],
  zoom: number,
  fitPoints?: [number, number][],
): { center: [number, number]; zoom: number } {
  if (fitPoints && fitPoints.length >= 2) {
    const lat = fitPoints.reduce((s, p) => s + p[0], 0) / fitPoints.length;
    const lon = fitPoints.reduce((s, p) => s + p[1], 0) / fitPoints.length;
    return { center: [lon, lat], zoom: 14 };
  }
  return { center: [center[1], center[0]], zoom };
}

export function RosmMap({
  center,
  zoom = 15,
  markers = [],
  line,
  showUserLocation,
  userPos,
  onMarkerPress,
  onMapPress,
  onRegionChange,
  initialOnly,
  recenterKey,
  showLocationButton,
  fitPoints,
  style,
}: Props) {
  const cameraRef = useRef<CameraRef>(null);
  const view = resolveView(center, zoom, fitPoints);

  // Serialized here, once per data change. GeoJSONSource stringifies an
  // object on every render it gets, and this map renders on every GPS fix and
  // pan settle; handed a string, it passes it through as it is.
  const markerData = useMemo(() => JSON.stringify(markerFeatures(markers)), [markers]);
  const lineData = useMemo(
    () => (line && line.length > 1 ? JSON.stringify(lineFeature(line)) : null),
    [line],
  );

  // Handlers read the latest callbacks through a ref, so each keeps one
  // identity for the life of the map (the marker source's memo depends on it).
  const callbacks = useRef({ onMarkerPress, onMapPress, onRegionChange });
  useEffect(() => {
    callbacks.current = { onMarkerPress, onMapPress, onRegionChange };
  });

  // Marker taps are hit-tested natively by the source itself — the pressed
  // feature rides in on the event, so there's no JS-side queryRenderedFeatures
  // round-trip (that async bridge hop was the ~1s open lag). stopPropagation
  // keeps the same tap from also bubbling to the map's onPress.
  const onMarkerHit = useCallback((e: NativeSyntheticEvent<MarkerPressEvent>) => {
    const mid = e.nativeEvent.features?.[0]?.properties?.mid;
    if (mid != null) {
      callbacks.current.onMarkerPress?.(resolveId(String(mid)));
      e.stopPropagation?.();
    }
  }, []);

  // Empty-map tap (no marker under the hitbox) → plain map press.
  const onMapTap = useCallback((e: NativeSyntheticEvent<PressEvent>) => {
    const [tapLon, tapLat] = e.nativeEvent.lngLat;
    callbacks.current.onMapPress?.(tapLat, tapLon);
  }, []);

  const onRegion = useCallback((e: NativeSyntheticEvent<RegionEvent>) => {
    const { center: c, zoom: z, bounds, userInteraction } = e.nativeEvent;
    // Ignore camera-driven settles so a recenter doesn't masquerade as a search.
    if (!userInteraction) return;
    callbacks.current.onRegionChange?.({ center: [c[1], c[0]], zoom: z, bounds });
  }, []);

  return (
    <>
      <Map
        style={[StyleSheet.absoluteFill, style]}
        mapStyle={OSM_STYLE_JSON}
        logo={false} // OSM credit stays in the attribution (ⓘ) button; drop the duplicate MapLibre wordmark
        touchRotate // two-finger rotate; required for the compass to ever appear
        compass // native compass button; shows when bearing != 0, tap resets to north
        compassHiddenFacingNorth // hide it once already north-up
        onPress={onMapPress ? onMapTap : undefined}
        onRegionDidChange={onRegionChange ? onRegion : undefined}
      >
        {initialOnly ? (
          <Camera
            ref={cameraRef}
            key={recenterKey}
            initialViewState={{ center: view.center, zoom: view.zoom }}
          />
        ) : (
          <Camera ref={cameraRef} center={view.center} zoom={view.zoom} />
        )}

        {lineData ? (
          <GeoJSONSource id="route" data={lineData}>
            {ROUTE_LAYERS}
          </GeoJSONSource>
        ) : null}

        <GeoJSONSource
          id="markers"
          data={markerData}
          onPress={onMarkerPress ? onMarkerHit : undefined}
        >
          {MARKER_LAYERS}
        </GeoJSONSource>

        {/* MapLibre's own location puck: it follows the device and animates
            the dot natively, so no location stream, animation frame or source
            update runs through JS. */}
        {showUserLocation ? (
          <NativeUserLocation mode="heading" androidPreferredFramesPerSecond={30} />
        ) : null}
      </Map>

      {showLocationButton && userPos ? (
        <Pressable
          onPress={() => cameraRef.current?.flyTo({ center: [userPos[1], userPos[0]], zoom: 16 })}
          accessibilityRole="button"
          accessibilityLabel="Go to my location"
          style={styles.locationButton}
        >
          <CrosshairSimpleIcon size={22} color="#1d1d1f" weight="bold" />
        </Pressable>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  locationButton: {
    position: "absolute",
    top: 60,
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255, 255, 255, 0.92)",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
});
