import { useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { ArrowSquareOutIcon } from "phosphor-react-native/src/icons/ArrowSquareOut";
import { CheckCircleIcon } from "phosphor-react-native/src/icons/CheckCircle";
import { SnowflakeIcon } from "phosphor-react-native/src/icons/Snowflake";
import { TrashIcon } from "phosphor-react-native/src/icons/Trash";
import { WarningIcon } from "phosphor-react-native/src/icons/Warning";
import { DogIcon } from "./icons/DogIcon";
import type { EditAction, EditExtras, Fountain } from "@rosm/core/schemas";
import type { SyncState } from "@rosm/core/stores/outbox";
import { PointDetailsForm } from "./PointDetailsForm";

export type SurveyAction = EditAction | "broken";

export type PointEdit = {
  status: SurveyAction;
  syncState: SyncState;
  changesetUrl?: string;
  extras?: EditExtras;
};

const STATUS_LABEL: Record<SurveyAction, string> = {
  confirm: "Confirmed working",
  broken: "Marked working but broken",
  out_of_order: "Marked out of order",
  removed: "Marked removed",
};

const SYNC_LABEL: Record<SyncState, string> = {
  pending: "Saved on device",
  sending: "Syncing…",
  sent: "Synced",
  failed: "Sync failed — will retry",
};

function isDogWater(tags: Record<string, string>): boolean {
  return tags.drinking_water === "no";
}

type ActionButton = {
  action: "confirm" | "problem" | "removed";
  title: string;
  Icon: typeof CheckCircleIcon;
  box: string;
  secondary?: true;
  borderClass?: string;
  textColorClass?: string;
  iconHex?: string;
};

const ACTIONS: ActionButton[] = [
  { action: "confirm", title: "Working", Icon: CheckCircleIcon, box: "bg-green-600" },
  { action: "problem", title: "Broken", Icon: WarningIcon, box: "bg-orange-600" },
  {
    action: "removed",
    title: "Removed",
    Icon: TrashIcon,
    box: "bg-red-600",
    secondary: true,
    borderClass: "border-2 border-red-600",
    textColorClass: "text-red-600",
    iconHex: "#dc2626",
  },
];

type Props = {
  fountain: Fountain;
  edit?: PointEdit;
  onAction: (action: SurveyAction, extras?: EditExtras) => void;
  inRoute?: boolean;
  onToggleRoute?: () => void;
};

export function PointSheet({ fountain, edit, onAction, inRoute, onToggleRoute }: Props) {
  const tags = fountain.tags ?? {};
  const [detailFor, setDetailFor] = useState<"confirm" | "problem" | "removed" | null>(null);

  const [prevId, setPrevId] = useState(fountain.id);
  if (prevId !== fountain.id) {
    setPrevId(fountain.id);
    setDetailFor(null);
  }

  const byAction = (action: ActionButton["action"]) => ACTIONS.find((a) => a.action === action)!;

  const renderAction = (a: ActionButton, extra: string, showLabel = true) => (
    <Pressable
      onPress={() => setDetailFor(a.action)}
      accessibilityRole="button"
      accessibilityLabel={a.title}
      className={`flex-row items-center justify-center gap-2 rounded-xl px-4 py-6 ${
        a.secondary ? a.borderClass : a.box
      } ${extra}`}
    >
      <a.Icon size={28} color={a.secondary ? a.iconHex! : "#ffffff"} weight="bold" />
      {showLabel ? (
        <Text
          className={`text-center text-xl font-bold ${a.secondary ? a.textColorClass : "text-white"}`}
        >
          {a.title}
        </Text>
      ) : null}
    </Pressable>
  );

  return (
    <View className="gap-3.5 px-1 py-1">
      {tags.name || isDogWater(tags) ? (
        <View className="pb-1">
          {tags.name ? <Text className="text-base text-lg font-bold">{tags.name}</Text> : null}
          {isDogWater(tags) ? (
            <View className="mt-1.5 flex-row items-center gap-1.5 self-start rounded-lg border border-violet-300 bg-violet-100 px-2.5 py-1">
              <DogIcon size={14} color="#5b21b6" />
              <Text className="text-xs font-bold text-violet-950">Dog water — not for humans</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {onToggleRoute ? (
        <Pressable
          onPress={onToggleRoute}
          accessibilityRole="button"
          className={`flex-row items-center justify-center gap-2 rounded-xl px-5 py-4 ${
            inRoute ? "bg-red-600" : "bg-green-600"
          }`}
        >
          <Text className="text-base font-bold text-white">
            {inRoute ? "Remove from route" : "Add to route"}
          </Text>
        </Pressable>
      ) : null}

      {edit ? (
        <View className="border-border bg-surface-deep gap-1.5 rounded-xl border p-4">
          <Text className="text-base font-bold">{STATUS_LABEL[edit.status]}</Text>
          {edit.extras?.seasonal ? (
            <View className="flex-row items-center gap-1">
              <SnowflakeIcon size={14} color="#0369a1" />
              <Text className="text-info-800 text-xs font-bold">Seasonal</Text>
            </View>
          ) : null}
          {edit.extras?.note ? (
            <Text className="text-base text-xs font-medium italic">“{edit.extras.note}”</Text>
          ) : null}
          <Text className="text-muted mt-0.5 text-xs font-bold">{SYNC_LABEL[edit.syncState]}</Text>
          {edit.changesetUrl ? (
            <Pressable
              onPress={() => Linking.openURL(edit.changesetUrl!)}
              // A 16pt line of text; the slop makes it a 44pt target.
              hitSlop={14}
              className="mt-0.5 flex-row items-center gap-1"
            >
              <ArrowSquareOutIcon size={14} color="#0c0d0a" />
              <Text className="text-base text-xs font-bold underline">View online</Text>
            </Pressable>
          ) : null}
        </View>
      ) : detailFor ? (
        <PointDetailsForm
          tags={tags}
          submitLabel={detailFor === "confirm" ? "Confirm working" : "Confirm removed"}
          SubmitIcon={detailFor === "confirm" ? CheckCircleIcon : TrashIcon}
          submitBox={detailFor === "confirm" ? "bg-green-600" : "bg-red-600"}
          isRemoved={detailFor === "removed"}
          isProblem={detailFor === "problem"}
          onCancel={() => setDetailFor(null)}
          onSubmit={(extras, action) => {
            onAction(action ?? (detailFor as SurveyAction), extras);
            setDetailFor(null);
          }}
        />
      ) : (
        <View className="gap-5 py-1">
          {renderAction(byAction("confirm"), "py-8")}
          <View className="flex-row gap-5">
            {renderAction(byAction("removed"), "px-8", false)}
            {renderAction(byAction("problem"), "flex-1")}
          </View>
        </View>
      )}
    </View>
  );
}
