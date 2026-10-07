import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CheckCircleIcon, SnowflakeIcon, WarningIcon, WrenchIcon } from "phosphor-react-native";
import type { Audience, Dispenser, EditExtras } from "@rosm/core/schemas";
import { audienceFromTags } from "@rosm/core/audience";
import { dispenserFromTags } from "@rosm/core/dispenser";
import { AudienceToggle } from "./AudienceToggle";
import { DispenserToggle } from "./DispenserToggle";
import { TextField } from "./ui/TextField";

const QUICK_TAGS = [
  "Not draining",
  "Low water pressure",
  "One fountain not running",
  "Bottle filler not running",
];

type Props = {
  tags: Record<string, string>;
  submitLabel: string;
  SubmitIcon?: typeof CheckCircleIcon;
  submitBox?: string;
  onSubmit: (extras?: EditExtras, action?: "out_of_order" | "broken") => void;
  onCancel?: () => void;
  isRemoved?: boolean;
  isOutOfOrder?: boolean;
  isBroken?: boolean;
  /** Merged "Something's wrong" flow — user picks out_of_order vs broken in-form. */
  isProblem?: boolean;
};

export function PointDetailsForm({
  tags,
  submitLabel,
  SubmitIcon = CheckCircleIcon,
  submitBox = "bg-green-600",
  onSubmit,
  onCancel,
  isRemoved = false,
  isOutOfOrder = false,
  isBroken = false,
  isProblem = false,
}: Props) {
  // In the merged "Something's wrong" flow, the user chooses the specific problem
  // here; that choice — not the caller — drives which fields show and which action fires.
  const [problemType, setProblemType] = useState<"out_of_order" | "broken">("out_of_order");
  const outOfOrder = isProblem ? problemType === "out_of_order" : isOutOfOrder;
  const broken = isProblem ? problemType === "broken" : isBroken;

  const effLabel = isProblem
    ? outOfOrder
      ? "Mark out of order"
      : "Mark working but broken"
    : submitLabel;
  const EffIcon = isProblem ? (outOfOrder ? WarningIcon : WrenchIcon) : SubmitIcon;
  const effBox = isProblem ? (outOfOrder ? "bg-orange-600" : "bg-amber-500") : submitBox;
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

  function toggleQuickTag(tagText: string) {
    if (note.includes(tagText)) {
      const updated = note
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s !== tagText)
        .join("; ");
      setNote(updated);
    } else {
      setNote(note ? `${note}; ${tagText}` : tagText);
    }
  }

  function handleSubmit() {
    const trimmed = note.trim();
    if (isRemoved) {
      onSubmit(trimmed ? { note: trimmed } : undefined);
      return;
    }
    const extras: EditExtras = { audience, dispenser };
    if (seasonal && !outOfOrder) extras.seasonal = true;
    if (trimmed) extras.note = trimmed;
    onSubmit(extras, isProblem ? problemType : undefined);
  }

  return (
    <View className="gap-3.5">
      {isProblem ? (
        <View className="gap-1.5">
          <Text className="text-base text-xs font-bold tracking-wider uppercase">
            What&apos;s the issue?
          </Text>
          <View className="flex-row gap-3">
            {(
              [
                ["out_of_order", "Out of order", WarningIcon],
                ["broken", "Working but broken", WrenchIcon],
              ] as const
            ).map(([value, label, Icon]) => {
              const active = problemType === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setProblemType(value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-xl border px-3 py-3 ${
                    active ? "border-orange-600 bg-orange-50" : "border-border bg-surface-deep"
                  }`}
                >
                  <Icon size={18} color={active ? "#ea580c" : "#57544a"} weight="bold" />
                  <Text className={`text-xs font-bold ${active ? "text-orange-600" : "text-base"}`}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {isRemoved ? (
        <View className="rounded-xl border border-red-300 bg-red-100 p-4">
          <Text className="text-sm font-bold text-red-950">
            Confirm marking this fountain as removed.
          </Text>
        </View>
      ) : (
        <>
          <AudienceToggle value={audience} onChange={setAudience} />
          <DispenserToggle value={dispenser} onChange={setDispenser} />

          {/* Seasonal checkbox hidden on out of order page */}
          {!outOfOrder ? (
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

      {/* "Working but broken" issue details + quick tag pills */}
      {broken ? (
        <View className="gap-2 pt-1">
          <Text className="text-base text-xs font-bold tracking-wider uppercase">
            What&apos;s wrong with the fountain?
          </Text>
          <View className="flex-row flex-wrap gap-1.5 pb-1">
            {QUICK_TAGS.map((tag) => {
              const active = note.includes(tag);
              return (
                <Pressable
                  key={tag}
                  onPress={() => toggleQuickTag(tag)}
                  className={`rounded-lg border px-2.5 py-1.5 ${
                    active ? "border-amber-600 bg-amber-500" : "border-border bg-surface-deep"
                  }`}
                >
                  <Text className={`text-xs font-bold ${active ? "text-white" : "text-base"}`}>
                    {tag}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <View className="gap-1.5">
        <Text className="text-base text-xs font-bold tracking-wider uppercase">
          {broken ? "Details / Note" : "Public Note"}
        </Text>
        <TextField
          value={note}
          onChangeText={setNote}
          placeholder={broken ? "Describe what's wrong…" : "Add a public note (optional)"}
          placeholderTextColor="#57544a"
          multiline
          maxLength={255}
          className="border-border min-h-20 rounded-xl border bg-white p-3.5 text-base text-sm font-medium"
        />
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
          className={`flex-1 flex-row items-center justify-center gap-2 rounded-xl px-4 py-3 ${effBox}`}
        >
          <EffIcon size={18} color="#ffffff" weight="bold" />
          <Text className="text-base font-bold text-white">{effLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}
