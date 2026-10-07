import { describe, expect, it } from "vitest";
import { EditExtras } from "../src/schemas";
import {
  NOTE_MAX,
  hasQuickTag,
  normalizeNote,
  noteTokens,
  stripLineBreaks,
  toggleQuickTag,
} from "../src/note";

describe("NOTE_MAX", () => {
  // The forms check this limit instead of running the zod schema client-side,
  // so it must stay exactly the server's.
  it("is exactly the note limit EditExtras enforces", () => {
    expect(EditExtras.safeParse({ note: "x".repeat(NOTE_MAX) }).success).toBe(true);
    expect(EditExtras.safeParse({ note: "x".repeat(NOTE_MAX + 1) }).success).toBe(false);
  });
});

describe("noteTokens", () => {
  it("splits on semicolons, trims, and drops empty parts", () => {
    expect(noteTokens(" Leaks ;;Not draining; ")).toEqual(["Leaks", "Not draining"]);
    expect(noteTokens("")).toEqual([]);
  });
});

describe("hasQuickTag", () => {
  it("matches whole tokens, not substrings", () => {
    expect(hasQuickTag("Not draining well", "Not draining")).toBe(false);
    expect(hasQuickTag("Leaks; Not draining", "Not draining")).toBe(true);
    expect(hasQuickTag("Leaks;Not draining ", "Not draining")).toBe(true);
  });
});

describe("toggleQuickTag", () => {
  it("appends to an empty or free-text note", () => {
    expect(toggleQuickTag("", "Not draining")).toBe("Not draining");
    expect(toggleQuickTag("Water is warm", "Not draining")).toBe("Water is warm; Not draining");
  });

  it("removes a tag that is present as a whole token", () => {
    expect(toggleQuickTag("Leaks; Not draining; Smells", "Not draining")).toBe("Leaks; Smells");
  });

  it("adds rather than removes when the tag only appears inside free text", () => {
    expect(toggleQuickTag("Not draining well", "Not draining")).toBe(
      "Not draining well; Not draining",
    );
  });

  it("round-trips: adding then removing restores the note, and never duplicates", () => {
    const added = toggleQuickTag("Leaks", "Low water pressure")!;
    expect(added).toBe("Leaks; Low water pressure");
    expect(toggleQuickTag(added, "Low water pressure")).toBe("Leaks");
    expect(noteTokens(added).filter((t) => t === "Low water pressure")).toHaveLength(1);
  });

  it("refuses an append that would exceed NOTE_MAX", () => {
    const tag = "Bottle filler not running";
    const fits = "x".repeat(NOTE_MAX - tag.length - 2); // room for "; " + tag exactly
    expect(toggleQuickTag(fits, tag)).toHaveLength(NOTE_MAX);
    expect(toggleQuickTag(`${fits}x`, tag)).toBeNull();
  });

  it("still removes a tag from a note that is already over the limit", () => {
    const long = `${"x".repeat(NOTE_MAX)}; Not draining`;
    expect(toggleQuickTag(long, "Not draining")).toBe("x".repeat(NOTE_MAX));
  });

  it("never produces a note the server schema rejects", () => {
    let note = "y".repeat(200);
    for (const tag of ["Not draining", "Low water pressure", "One fountain not running"]) {
      note = toggleQuickTag(note, tag) ?? note;
    }
    expect(EditExtras.safeParse({ note }).success).toBe(true);
  });
});

describe("stripLineBreaks", () => {
  it("turns every kind of line break into a space", () => {
    expect(stripLineBreaks("a\nb\r\nc\rd\u2028e\u2029f")).toBe("a b c d e f");
  });

  it("leaves spacing alone so typing a space is never undone", () => {
    expect(stripLineBreaks("Not ")).toBe("Not ");
    expect(stripLineBreaks("  two  spaces  ")).toBe("  two  spaces  ");
  });
});

describe("normalizeNote", () => {
  it("collapses whitespace runs, including CRLF and newlines, and trims", () => {
    expect(normalizeNote("  Leaks\r\n\r\nnear   the\tbase \n")).toBe("Leaks near the base");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeNote(" \n\t ")).toBe("");
  });
});
