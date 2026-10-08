import { Pressable, Text, View } from "react-native";
import type { Dispenser } from "@water-run/core/schemas";
import { BubblerIcon, BothDispenserIcon, BottleIcon } from "./icons/DispenserIcons";

const OPTIONS: readonly {
  key: Dispenser;
  label: string;
  Icon: typeof BubblerIcon;
}[] = [
  { key: "bubbler", label: "Bubbler", Icon: BubblerIcon },
  { key: "both", label: "Both", Icon: BothDispenserIcon },
  { key: "bottle", label: "Bottle filler", Icon: BottleIcon },
];

export function DispenserToggle({
  value,
  onChange,
  label = "Dispenser",
}: {
  value: Dispenser;
  onChange: (d: Dispenser) => void;
  label?: string;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-base text-xs font-bold tracking-wider uppercase">{label}</Text>
      <View className="border-border bg-surface-deep flex-row rounded-xl border p-1">
        {OPTIONS.map(({ key, label: optLabel, Icon }) => {
          const selected = value === key;
          const color = selected ? "#ffffff" : "#0c0d0a";
          return (
            <Pressable
              key={key}
              onPress={() => onChange(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              className={`flex-1 flex-row items-center justify-center gap-1.5 rounded-lg py-2.5 ${
                selected ? "bg-base shadow-sm" : ""
              }`}
            >
              <Icon size={16} color={color} />
              <Text className={`text-xs font-bold ${selected ? "text-surface" : "text-base"}`}>
                {optLabel}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
