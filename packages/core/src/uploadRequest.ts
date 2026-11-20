import { z } from "zod";
import { EditAction, EditExtras, TagFilterSchema } from "./schemas";

// A whole run's reviewed updates, written to OSM in one atomic diff upload
// (/api/osm/upload). `key` is the client's id for the item, so a refusal can
// name which items it is about. `surveyDate` is the surveyor's local day,
// checked by the server the same way as an edit's.
const ProposalKey = z.string().min(1).max(64);
const SurveyDate = z.iso.date().optional();

export const UploadEdit = z.object({
  key: ProposalKey,
  nodeId: z.number().int().positive(),
  action: EditAction,
  tagKey: z.string().min(1).default("amenity"),
  extras: EditExtras.optional(),
  surveyDate: SurveyDate,
});
export type UploadEdit = z.infer<typeof UploadEdit>;

export const UploadCreate = z.object({
  key: ProposalKey,
  // OSM's placeholder id for an element the upload creates.
  tempId: z.number().int().negative(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  tag: TagFilterSchema,
  extras: EditExtras.optional(),
  surveyDate: SurveyDate,
});
export type UploadCreate = z.infer<typeof UploadCreate>;

// Well under OSM's 10,000 changes per changeset; a run is a few dozen.
export const MAX_UPLOAD_ITEMS = 1000;

export const UploadRequest = z
  .object({
    changesetId: z.number().int().positive(),
    edits: z.array(UploadEdit).default([]),
    creates: z.array(UploadCreate).default([]),
  })
  .refine((d) => d.edits.length + d.creates.length > 0, { message: "Nothing to upload." })
  .refine((d) => d.edits.length + d.creates.length <= MAX_UPLOAD_ITEMS, {
    message: "Too many updates for one upload.",
  })
  // One write per node: the diff can't modify a node twice from one version.
  .refine((d) => new Set(d.edits.map((e) => e.nodeId)).size === d.edits.length, {
    message: "A point can only be updated once per upload.",
  })
  .refine((d) => new Set(d.creates.map((c) => c.tempId)).size === d.creates.length, {
    message: "Placeholder ids must be unique.",
  })
  .refine(
    (d) =>
      new Set([...d.edits, ...d.creates].map((i) => i.key)).size ===
      d.edits.length + d.creates.length,
    { message: "Item keys must be unique." },
  );
export type UploadRequest = z.infer<typeof UploadRequest>;
