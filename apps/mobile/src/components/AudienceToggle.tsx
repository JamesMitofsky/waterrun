import type { ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { UserIcon } from "phosphor-react-native/src/icons/User";
import type { Audience } from "@rosm/core/schemas";
import { DogIcon } from "./icons/DogIcon";
import { BothAudienceIcon } from "./icons/BothAudienceIcon";

const OPTIONS: readonly {
  key: Audience;
  label: string;
  Icon: ComponentType<{ size?: number; color?: string }>;
}[] = [
  { key: "humans", label: "Humans", Icon: UserIcon },
  { key: "both", label: "Both", Icon: BothAudienceIcon },
  { key: "dogs", label: "Dogs", Icon: DogIcon },
];

export function AudienceToggle({
  value,
  onChange,
  label = "Intended for",
}: {
  value: Audience;
  onChange: (a: Audience) => void;
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
