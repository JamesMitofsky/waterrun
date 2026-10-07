/**
 * How long `MapFrame.astro`'s loading overlay takes to dissolve once the map
 * underneath reports its first paint.
 *
 * Long enough to read as the frame clearing rather than as a cut, and no
 * longer: the map is already drawn and interactive by then, so every extra
 * millisecond is a finished map behind frosted glass. Part of the frame
 * contract in `frames.ts`, which re-exports it, because a map that starts
 * something the moment it is revealed (`DemoRunMap`'s replay) has to wait this
 * out first.
 *
 * A module of its own, with no imports, so `MapFrame`'s client script can read
 * it without loading `frames.ts`: that module pulls in the demo route and runs
 * code at import, so the bundler had to ship it, and the route-line chunk it
 * imports, to every map page just for this number.
 */
export const MAP_REVEAL_MS = 280;
