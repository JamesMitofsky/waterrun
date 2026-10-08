import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CheckCircleIcon } from "phosphor-react-native/src/icons/CheckCircle";
import { SnowflakeIcon } from "phosphor-react-native/src/icons/Snowflake";
import type { Audience, Dispenser, EditExtras } from "@water-run/core/schemas";
import { audienceFromTags } from "@water-run/core/audience";
import { dispenserFromTags } from "@water-run/core/dispenser";
import { NOTE_MAX, hasQuickTag, normalizeNote, toggleQuickTag } from "@water-run/core/note";
import { AudienceToggle } from "./AudienceToggle";
import { DispenserToggle } from "./DispenserToggle";
import { TextField } from "./ui/TextField";

const QUICK_TAGS = [
  "Not draining",
  "Low water pressure",
  "One fountain not running",
  "Bottle filler not running",
];

// The color of a filled button's label and icon. Light (white) on the
// saturated fills; dark on a light fill such as amber, where white falls
// under 3:1 contrast.
export type Ink = "light" | "dark";
export const INK: Record<Ink, { text: string; hex: string }> = {
  light: { text: "text-white", hex: "#ffffff" },
  dark: { text: "text-base", hex: "#0c0d0a" },
};

type Props = {
  tags: Record<string, string>;
  submitLabel: string;
  SubmitIcon?: typeof CheckCircleIcon;
  submitBox?: string;
  submitInk?: Ink;
  onSubmit: (extras?: EditExtras) => void;
  onCancel?: () => void;
  isRemoved?: boolean;
  isOutOfOrder?: boolean;
  isBroken?: boolean;
};

export function PointDetailsForm({
  tags,
  submitLabel,
  SubmitIcon = CheckCircleIcon,
  submitBox = "bg-green-600",
  submitInk = "light",
  onSubmit,
  onCancel,
  isRemoved = false,
  isOutOfOrder = false,
  isBroken = false,
}: Props) {
  // Derive initial values from tags — recalculated when `tags` identity changes.
  const defaults = useMemo(
    () => ({
      audience: audienceFromTags(tags),
      dispenser: dispenserFromTags(tags),
      seasonal: tags.seasonal === "yes",
      note: tags.note ?? tags.description ?? "",
    }),
    [tags],
  );

  const [audience, setAudience] = useState<Audience>(defaults.audience);
  const [dispenser, setDispenser] = useState<Dispenser>(defaults.dispenser);
  const [seasonal, setSeasonal] = useState(defaults.seasonal);
  const [note, setNote] = useState(defaults.note);
  const [error, setError] = useState<string | null>(null);

  function editNote(next: string) {
    setNote(next);
    setError(null);
  }

  // Each pill's next note, or null when adding it would overflow NOTE_MAX.
  const quickTags = QUICK_TAGS.map((tag) => ({
    tag,
    active: hasQuickTag(note, tag),
    next: toggleQuickTag(note, tag),
  }));

  function handleSubmit() {
    const cleaned = normalizeNote(note);
    // Stop here rather than queue an edit the server will reject for good:
    // only the user can shorten their note. The note is the one free-text
    // field EditExtras can refuse (a core test pins NOTE_MAX to its limit), so
    // this avoids pulling zod into the app bundle just to safeParse.
    if (cleaned.length > NOTE_MAX) {
      setError(`Shorten the note to ${NOTE_MAX} characters (it has ${cleaned.length}).`);
      return;
    }
    if (isRemoved) {
      onSubmit(cleaned ? { note: cleaned } : undefined);
      return;
    }
    const extras: EditExtras = { audience, dispenser };
    if (seasonal && !isOutOfOrder) extras.seasonal = true;
    if (cleaned) extras.note = cleaned;
    onSubmit(extras);
  }

  return (
    <View className="gap-3.5">
      {isRemoved ? (
        <View className="rounded-xl border border-red-300 bg-red-100 p-4">
          <Text className="text-sm font-bold text-red-950">
            Confirm there&apos;s no fountain here.
          </Text>
        </View>
      ) : (
        <>
          <AudienceToggle value={audience} onChange={setAudience} />
          <DispenserToggle value={dispenser} onChange={setDispenser} />

          {/* Seasonal checkbox hidden on out of order page */}
          {!isOutOfOrder ? (
            <Pressable
              onPress={() => setSeasonal((s) => !s)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: seasonal }}
              accessibilityLabel="Seasonal fountain"
              className={`flex-row items-center justify-between rounded-xl border p-4 ${
                seasonal ? "border-info-500 bg-info-50" : "border-border bg-surface-deep"
              }`}
            >
              <View className="flex-row items-center gap-3">
                <View
                  className={`h-6 w-6 items-center justify-center rounded-lg border ${
                    seasonal ? "border-info-600 bg-info-600" : "border-border bg-white"
                  }`}
                >
                  {seasonal ? <Text className="text-xs font-black text-white">✓</Text> : null}
                </View>
                <View className="gap-0.5">
                  <Text className="text-base text-sm font-bold">Seasonal fountain</Text>
                  <Text className="text-muted text-xs font-semibold">
                    Runs only part of the year
                  </Text>
                </View>
              </View>
              <SnowflakeIcon
                size={20}
                color={seasonal ? "#0284c7" : "#57544a"}
                weight={seasonal ? "fill" : "regular"}
              />
            </Pressable>
          ) : null}
        </>
      )}

      {/* "Partially working" issue details + quick tag pills */}
      {isBroken ? (
        <View className="gap-2 pt-1">
          <Text className="text-base text-xs font-bold tracking-wider uppercase">
            What&apos;s wrong with the fountain?
          </Text>
          <View className="flex-row flex-wrap gap-1.5 pb-1">
            {quickTags.map(({ tag, active, next }) => (
              <Pressable
                key={tag}
                onPress={() => next !== null && editNote(next)}
                disabled={next === null}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: next === null }}
                // Half the 6px gap, so neighbouring pills' targets never overlap.
                hitSlop={3}
                className={`rounded-lg border px-2.5 py-2 ${
                  active ? "border-amber-600 bg-amber-500" : "border-border bg-surface-deep"
                } ${next === null ? "opacity-40" : ""}`}
              >
                <Text className={`text-xs font-bold ${active ? "text-white" : "text-base"}`}>
                  {tag}
                </Text>
              </Pressable>
            ))}
          </View>
          {quickTags.some((q) => q.next === null) ? (
            <Text className="text-muted text-xs font-semibold">
              Note is full. Shorten it to add more.
            </Text>
          ) : null}
        </View>
      ) : null}

      <View className="gap-1.5">
        <Text className="text-base text-xs font-bold tracking-wider uppercase">
          {isBroken ? "Details / Note" : "Public Note"}
        </Text>
        <TextField
          value={note}
          onChangeText={editNote}
          placeholder={isBroken ? "Describe what's wrong…" : "Add a public note (optional)"}
          placeholderTextColor="#57544a"
          multiline
          maxLength={NOTE_MAX}
          className="border-border min-h-20 rounded-xl border bg-white p-3.5 text-base text-sm font-medium"
        />
        {error ? <Text className="text-sm font-semibold text-red-600">{error}</Text> : null}
      </View>

      <View className="flex-row gap-3 pt-2">
        {onCancel ? (
          // Intrinsic width, so the submit label keeps the rest of the row.
          <Pressable
            onPress={onCancel}
            accessibilityRole="button"
            className="border-border bg-surface-deep items-center justify-center rounded-xl border px-4 py-3"
          >
            <Text className="text-base font-bold">Back</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={handleSubmit}
          accessibilityRole="button"
          className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl px-4 py-3 ${submitBox}`}
        >
          <SubmitIcon size={18} color={INK[submitInk].hex} weight="bold" />
          <Text className={`text-base font-bold ${INK[submitInk].text}`}>{submitLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
