import { useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { ArrowSquareOutIcon } from "phosphor-react-native/src/icons/ArrowSquareOut";
import { CheckCircleIcon } from "phosphor-react-native/src/icons/CheckCircle";
import { DropHalfIcon } from "phosphor-react-native/src/icons/DropHalf";
import { DropSlashIcon } from "phosphor-react-native/src/icons/DropSlash";
import { SnowflakeIcon } from "phosphor-react-native/src/icons/Snowflake";
import { TrashIcon } from "phosphor-react-native/src/icons/Trash";
import { WarningIcon } from "phosphor-react-native/src/icons/Warning";
import { WrenchIcon } from "phosphor-react-native/src/icons/Wrench";
import { DogIcon } from "./icons/DogIcon";
import { pointStatusLine } from "@water-run/core/pointStatus";
import type { EditAction, EditExtras, Fountain } from "@water-run/core/schemas";
import { useOutbox, type OutboxItem, type SyncState } from "@water-run/core/stores/outbox";
import { INK, PointDetailsForm, type Ink } from "./PointDetailsForm";

export type SurveyAction = EditAction | "broken";

export type PointEdit = {
  status: SurveyAction;
  syncState: SyncState;
  // Why the last send failed. On a pending edit: it will be resent by itself.
  error?: string;
  changesetUrl?: string;
  extras?: EditExtras;
};

// What the sheet shows for a queued edit.
export function pointEditOf(item: OutboxItem): PointEdit {
  return {
    status: item.action,
    syncState: item.syncState,
    error: item.error,
    changesetUrl: item.changesetUrl,
    extras: item.extras,
  };
}

const STATUS_LABEL: Record<SurveyAction, string> = {
  confirm: "Confirmed working",
  broken: "Marked partially working",
  out_of_order: "Marked out of order",
  removed: "Marked removed",
};

// Where the edit is on its way to OSM (see SyncState). A pending edit with an
// error has been tried and the outbox will resend it by itself; a failed one
// it won't, so that one gets a Retry.
function syncLabel(edit: PointEdit): string {
  switch (edit.syncState) {
    case "pending":
      return edit.error ? "Waiting to send" : "Saved on device";
    case "sending":
      return "Syncing…";
    case "sent":
      return "Synced";
    case "failed":
      return "Couldn't sync";
  }
}

function isDogWater(tags: Record<string, string>): boolean {
  return tags.drinking_water === "no";
}

// The survey asks one question at a time, so a runner glancing down mid-run
// only ever weighs two answers: working or not; if not, gone or broken; if
// broken, how badly. Each leaf opens that action's details form.
type Step = "choose" | "problem" | "broken";

// The submit button of the details form behind each leaf of the steps above.
// Amber takes dark ink: white on it is about 2:1, too faint to read at a
// glance mid-run.
const FORMS: Record<
  SurveyAction,
  { label: string; Icon: typeof CheckCircleIcon; box: string; ink?: Ink }
> = {
  confirm: { label: "Confirm working", Icon: CheckCircleIcon, box: "bg-green-600" },
  broken: { label: "Mark partially working", Icon: DropHalfIcon, box: "bg-amber-500", ink: "dark" },
  out_of_order: { label: "Mark out of order", Icon: DropSlashIcon, box: "bg-orange-600" },
  removed: { label: "Confirm no fountain", Icon: TrashIcon, box: "bg-red-600" },
};

type ChoiceButtonProps = {
  title: string;
  Icon: typeof CheckCircleIcon;
  onPress: () => void;
  // The fill of a solid button. Without one the button is outlined in red
  // instead, the look kept for "No fountain": the one answer that says the
  // fountain is gone rather than just not working.
  box?: string;
  // The label's and icon's color on that fill (see Ink).
  ink?: Ink;
};

// A full-width answer, tall enough to hit one-handed mid-run.
function ChoiceButton({ title, Icon, onPress, box, ink = "light" }: ChoiceButtonProps) {
  const fg = box ? INK[ink] : { text: "text-red-600", hex: "#dc2626" };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      className={`flex-row items-center justify-center gap-2 rounded-xl px-4 py-8 ${
        box ?? "border-2 border-red-600"
      }`}
    >
      <Icon size={28} color={fg.hex} weight="bold" />
      <Text className={`text-center text-xl font-bold ${fg.text}`}>{title}</Text>
    </Pressable>
  );
}

// Styled as the details form's section labels.
function StepHeading({ title }: { title: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="text-base text-xs font-bold tracking-wider uppercase"
    >
      {title}
    </Text>
  );
}

// Styled as the details form's Back, and left-aligned where that one sits.
function BackButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Back"
      className="border-border bg-surface-deep items-center justify-center self-start rounded-xl border px-4 py-3"
    >
      <Text className="text-base font-bold">Back</Text>
    </Pressable>
  );
}

type Props = {
  fountain: Fountain;
  edit?: PointEdit;
  // May return a promise, for an action that can fail where the user can't
  // simply come back to it (adding a new point): the form then stays open with
  // what was entered until it resolves, and a rejection's message shows under
  // it so the user can try again.
  onAction: (action: SurveyAction, extras?: EditExtras) => void | Promise<void>;
  inRoute?: boolean;
  onToggleRoute?: () => void;
};

export function PointSheet({ fountain, edit, onAction, inRoute, onToggleRoute }: Props) {
  const tags = fountain.tags ?? {};
  const [step, setStep] = useState<Step>("choose");
  // The step stays put while a form is open, so the form's Back lands on the
  // step it was opened from.
  const [detailFor, setDetailFor] = useState<SurveyAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set synchronously, so a second tap before the re-render can't submit twice.
  const inFlight = useRef(false);

  const [prevId, setPrevId] = useState(fountain.id);
  if (prevId !== fountain.id) {
    setPrevId(fountain.id);
    setStep("choose");
    setDetailFor(null);
    setFailure(null);
  }

  // What OSM says about the point, shown over the survey steps only: the forms
  // and the recorded edit say what is being or was just recorded, which this
  // line would contradict. A point not in OSM yet (run.tsx's add sheet passes
  // id -1, OSM's mark for an object still to be created) gets no line at all:
  // its tags are only the defaults it was handed, so the line would report a
  // state nobody mapped. The label needn't tick while the sheet is up.
  const [now] = useState(() => Date.now());
  const statusLine = fountain.id < 0 ? null : pointStatusLine(tags, now);

  const submit = async (action: SurveyAction, extras?: EditExtras) => {
    if (inFlight.current) return;
    const result = onAction(action, extras);
    if (result instanceof Promise) {
      inFlight.current = true;
      setSaving(true);
      setFailure(null);
      try {
        await result;
      } catch (e) {
        setFailure(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    }
    setDetailFor(null);
    setStep("choose");
  };

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
          <View className="mt-0.5 flex-row items-center gap-3">
            <Text className="text-muted text-xs font-bold">{syncLabel(edit)}</Text>
            {edit.syncState === "failed" ? (
              <Pressable
                onPress={() => void useOutbox.getState().retryAll()}
                accessibilityRole="button"
                accessibilityLabel="Retry sending"
                // A 16pt line of text; the slop makes it a 44pt target.
                hitSlop={14}
              >
                <Text className="text-base text-xs font-bold underline">Retry</Text>
              </Pressable>
            ) : null}
          </View>
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
        <>
          <PointDetailsForm
            tags={tags}
            submitLabel={FORMS[detailFor].label}
            SubmitIcon={FORMS[detailFor].Icon}
            submitBox={FORMS[detailFor].box}
            submitInk={FORMS[detailFor].ink}
            isRemoved={detailFor === "removed"}
            isOutOfOrder={detailFor === "out_of_order"}
            isBroken={detailFor === "broken"}
            onCancel={() => {
              setDetailFor(null);
              setFailure(null);
            }}
            onSubmit={(extras) => void submit(detailFor, extras)}
          />
          {saving ? (
            <Text className="text-muted text-sm font-semibold">Saving…</Text>
          ) : failure ? (
            <Text className="text-sm font-semibold text-red-600">{failure}</Text>
          ) : null}
        </>
      ) : (
        <View className="gap-5 py-1">
          {statusLine ? (
            <Text className="text-muted text-sm font-semibold">{statusLine}</Text>
          ) : null}
          {step === "choose" ? (
            <>
              <ChoiceButton
                title="Working"
                Icon={CheckCircleIcon}
                box="bg-green-600"
                onPress={() => setDetailFor("confirm")}
              />
              <ChoiceButton
                title="Problem"
                Icon={WarningIcon}
                box="bg-orange-600"
                onPress={() => setStep("problem")}
              />
            </>
          ) : step === "problem" ? (
            <>
              <StepHeading title="What's wrong?" />
              <ChoiceButton
                title="No fountain"
                Icon={TrashIcon}
                onPress={() => setDetailFor("removed")}
              />
              <ChoiceButton
                title="Broken"
                Icon={WrenchIcon}
                box="bg-orange-600"
                onPress={() => setStep("broken")}
              />
              <BackButton onPress={() => setStep("choose")} />
            </>
          ) : (
            <>
              <StepHeading title="How broken is it?" />
              <ChoiceButton
                title="Partially working"
                Icon={DropHalfIcon}
                box="bg-amber-500"
                ink="dark"
                onPress={() => setDetailFor("broken")}
              />
              <ChoiceButton
                title="Totally out of order"
                Icon={DropSlashIcon}
                box="bg-orange-600"
                onPress={() => setDetailFor("out_of_order")}
              />
              <BackButton onPress={() => setStep("problem")} />
            </>
          )}
        </View>
      )}
    </View>
  );
}
