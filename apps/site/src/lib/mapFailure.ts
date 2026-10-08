/**
 * Why a map is showing its error card instead of itself.
 *
 * - `fatal`: nothing will draw — a source that failed outright (see
 *   {@link isFatalMapError}), or the map's subtree threw, as MapLibre's
 *   constructor does when the browser has no WebGL to give it.
 * - `timeout`: no `load` within the deadline. Not a verdict: a map that was
 *   only slow can still load, and when it does the card goes away.
 */
export type MapFailure = "fatal" | "timeout";

/**
 * Whether a MapLibre `error` event leaves the map with nothing to draw, rather
 * than missing a piece.
 *
 * MapLibre reports every failure through the one event, and most are not
 * fatal. A tile that failed (the event carries `tile`) counts as loaded, and
 * the map renders around it. A sprite or glyph that failed (no `sourceId`)
 * costs icons or labels, not the map. A source that failed outright — its
 * TileJSON, say — is the fatal one: MapLibre marks it loaded anyway, so `load`
 * still fires, over a blank map.
 */
export function isFatalMapError(ev: object): boolean {
  return "sourceId" in ev && !("tile" in ev);
}
