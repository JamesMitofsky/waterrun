// HUMAN ONLY FILE. AI should never edit.

import { z } from "zod";
import { MAX_SEARCH_RADIUS_M, boundsHalfDiagonalM } from "./geo";

// A point fetched from OSM (Overpass), with its raw tags.
export const FountainSchema = z.object({
  id: z.number(), // OSM node id
  lat: z.number(),
  lon: z.number(),
  tags: z.record(z.string(), z.string()).default({}),
});
export type Fountain = z.infer<typeof FountainSchema>;

// State the surveyor records on arrival.
export const EditAction = z.enum(["confirm", "broken", "out_of_order", "removed"]);
export type EditAction = z.infer<typeof EditAction>;

// Optional advanced OSM facts recorded alongside an action. These become real
// node tags (written to OSM), unlike the old local-only comment.
// Who the water source is intended for. Maps to drinking_water=* (human
// potability) + dog=* on the node.
export const Audience = z.enum(["humans", "dogs", "both"]);
export type Audience = z.infer<typeof Audience>;

// How the water is dispensed. Maps to fountain=bubbler + bottle=* on the node.
export const Dispenser = z.enum(["bubbler", "bottle", "both"]);
export type Dispenser = z.infer<typeof Dispenser>;

export const EditExtras = z.object({
  seasonal: z.boolean().optional(), // seasonal=yes: source runs only part of the year
  audience: Audience.optional(), // humans / dogs / both → drinking_water + dog tags
  dispenser: Dispenser.optional(), // bubbler / bottle-filler / both → fountain + bottle tags
  note: z.string().max(255).optional(), // OSM note=* : public free-text on the node
});
export type EditExtras = z.infer<typeof EditExtras>;

// Targetable OSM tag (key=value), e.g. amenity=drinking_water.
export const TagFilterSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
});
export type TagFilter = z.infer<typeof TagFilterSchema>;

// How to filter points by when they were last surveyed (check_date tag).
// "any" = no filter; "stale" = not checked within the window (or never checked,
// i.e. worth verifying); "fresh" = checked within the window.
export const RecencyMode = z.enum(["any", "stale", "fresh"]);
export type RecencyMode = z.infer<typeof RecencyMode>;

// A search covers either a circle (anchor lat/lon + radiusM) or the exact
// viewport rectangle (bounds = [south, west, north, east]). Exactly one mode
// must be supplied. Both are size-capped so a zoomed-way-out query can't sweep
// a whole region off the shared Overpass mirrors — the backstop for the
// client-side "Search this area" button gate.
const Bounds = z.tuple([z.number(), z.number(), z.number(), z.number()]);

export const FountainsRequest = z
  .object({
    lat: z.number().optional(),
    lon: z.number().optional(),
    radiusM: z.number().positive().max(MAX_SEARCH_RADIUS_M).optional(),
    bounds: Bounds.optional(),
    tag: TagFilterSchema,
    recencyMode: RecencyMode.default("any"),
    recencyMonths: z.number().positive().default(6),
    // Also fetch the disused: lifecycle variant so out-of-order points can be
    // surfaced and filtered client-side. abandoned: (removed) is never fetched:
    // a removed point doesn't appear on the map at all. Off by default so the
    // survey tool keeps seeing only active points.
    includeDisused: z.boolean().default(false),
  })
  .refine(
    (d) => {
      const circle = d.lat != null && d.lon != null && d.radiusM != null;
      const box = d.bounds != null;
      return circle !== box; // exactly one mode
    },
    { message: "Provide either lat/lon/radiusM or bounds, not both." },
  )
  .refine((d) => d.bounds == null || boundsHalfDiagonalM(d.bounds) <= MAX_SEARCH_RADIUS_M, {
    message: "Search area too large.",
    path: ["bounds"],
  });

// Create a brand-new OSM node at a surveyed location, tagged with the point
// type currently being surveyed (e.g. amenity=drinking_water). Extras carry the
// same survey facts as a confirm edit (audience, seasonal, note) so a new point
// is born fully described.
export const CreateNodeRequest = z.object({
  lat: z.number(),
  lon: z.number(),
  tag: TagFilterSchema,
  changesetId: z.number().optional(),
  extras: EditExtras.optional(),
});

export const RouteRequest = z.object({
  // ordered waypoints (start first); planner has already chosen + ordered them
  points: z.array(z.object({ lat: z.number(), lon: z.number() })).min(2),
  loop: z.boolean(),
});

export const EditRequest = z.object({
  nodeId: z.number(),
  action: EditAction,
  tagKey: z.string().default("amenity"), // primary key to lifecycle-prefix
  changesetId: z.number().optional(),
  extras: EditExtras.optional(), // advanced OSM tags (seasonal, note)
});

// Undo a submission that already reached OSM: restore the node's previous
// version (kind "edit") or delete the node we created (kind "create").
export const RevertRequest = z.object({
  nodeId: z.number(),
  kind: z.enum(["edit", "create"]),
  sentVersion: z.number(), // the version our submission produced (creates: 1)
  changesetId: z.number().optional(),
});

// Persisted record of an edit we made (local audit log). Besides survey actions,
// the log also records node creations and undo reverts.
export const EditLogEntrySchema = z.object({
  nodeId: z.number(),
  action: EditAction.or(z.enum(["create", "revert"])),
  changesetId: z.number(),
  newVersion: z.number(),
  at: z.string(), // ISO timestamp
  extras: EditExtras.optional(), // advanced OSM tags (seasonal, note)
});
export type EditLogEntry = z.infer<typeof EditLogEntrySchema>;
