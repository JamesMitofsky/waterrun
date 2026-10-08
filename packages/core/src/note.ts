// The free-text OSM note=* a surveyor edits alongside a status. Shared by the
// app and web forms so quick-tag pills, the length cap and whitespace handling
// all agree with the EditExtras schema the server validates against.

// EditExtras.note is z.string().max(255) (OSM's tag-value cap, counted as JS
// string length), so a longer note is a 400 that no retry can fix.
export const NOTE_MAX = 255;

// Quick tags join the note the OSM way for multiple values: "a; b; c".
const SEPARATOR = "; ";

// The note's ";"-separated parts, trimmed, with empty parts dropped.
export function noteTokens(note: string): string[] {
  return note
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Whole-token match, so a note reading "Not draining well" doesn't light (and
// then fail to remove) the "Not draining" pill the way a substring test did.
export function hasQuickTag(note: string, tag: string): boolean {
  return noteTokens(note).includes(tag);
}

// The note with `tag` removed if present, else appended. Null when appending
// would push the note past NOTE_MAX: the pill is refused up front rather than
// queueing an edit the server is bound to reject. Removal can't overflow.
export function toggleQuickTag(note: string, tag: string): string | null {
  const tokens = noteTokens(note);
  if (tokens.includes(tag)) return tokens.filter((t) => t !== tag).join(SEPARATOR);
  const next = [...tokens, tag].join(SEPARATOR);
  return next.length > NOTE_MAX ? null : next;
}

// Line breaks become spaces as they arrive, and nothing else changes, so typing
// is never disturbed (trimming here would eat the space just typed). OSM can't
// keep them anyway: XML attribute normalization turns a raw LF in v="…" into a
// space. The app's single Return key closes the keyboard, so in practice this
// catches pasted text, which iOS inserts without consulting the Return handler.
export function stripLineBreaks(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
}

// The note as it should be stored: whitespace runs collapsed, ends trimmed.
// Only for submit; while typing use stripLineBreaks.
export function normalizeNote(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}
