import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { ArrowSquareOutIcon } from "phosphor-react-native/src/icons/ArrowSquareOut";
import { CaretLeftIcon } from "phosphor-react-native/src/icons/CaretLeft";
import { CheckCircleIcon } from "phosphor-react-native/src/icons/CheckCircle";
import { PlusCircleIcon } from "phosphor-react-native/src/icons/PlusCircle";
import { DropHalfIcon } from "phosphor-react-native/src/icons/DropHalf";
import { DropSlashIcon } from "phosphor-react-native/src/icons/DropSlash";
import { SnowflakeIcon } from "phosphor-react-native/src/icons/Snowflake";
import { TrashIcon } from "phosphor-react-native/src/icons/Trash";
import { WarningIcon } from "phosphor-react-native/src/icons/Warning";
import { WrenchIcon } from "phosphor-react-native/src/icons/Wrench";
import { DogIcon } from "./icons/DogIcon";
import { EDIT_COLOR } from "@water-run/core/editStatus";
import { pointStatusLine } from "@water-run/core/pointStatus";
import type { EditAction, EditExtras, Fountain } from "@water-run/core/schemas";
import { surveyExtras, surveyFormDefaults } from "@water-run/core/surveyDefaults";
import { useOutbox, type OutboxItem, type SyncState } from "@water-run/core/stores/outbox";
import { INK, PointDetailsForm, type Ink } from "./PointDetailsForm";
import { useSignedIn } from "../auth/useSignedIn";
import { SignInButton } from "../auth/SignInButton";
import { announce } from "../ports/accessibility";
import { hapticSelect } from "../ports/haptics";
import { PopIn } from "./ui/PopIn";

export type SurveyAction = EditAction | "broken";

export type PointEdit = {
  status: SurveyAction;
  syncState: SyncState;
  // Why the last send failed. On a pending edit: it will be resent by itself.
  error?: string;
  changesetUrl?: string;
  extras?: EditExtras;
  // The queued edit, and until when it can still be taken back (epoch ms):
  // inside the outbox's undo hold, before any send (see isUndoable).
  id?: string;
  undoUntil?: number;
};

// What the sheet shows for a queued edit.
export function pointEditOf(item: OutboxItem): PointEdit {
  const undoable = item.syncState === "pending" && (item.attempts ?? 0) === 0 && item.holdUntil;
  return {
    status: item.action,
    syncState: item.syncState,
    error: item.error,
    changesetUrl: item.changesetUrl,
    extras: item.extras,
    id: item.id,
    undoUntil: undoable ? Date.parse(item.holdUntil!) : undefined,
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
function syncLabel(edit: PointEdit, signedIn: boolean): string {
  switch (edit.syncState) {
    case "pending":
      if (!signedIn) return "Saved on this phone";
      return edit.error ? "Waiting to send" : "Saved on this phone";
    case "sending":
      return "Sending…";
    case "sent":
      return "Sent to the map";
    case "failed":
      return "Couldn't send";
  }
}

function isDogWater(tags: Record<string, string>): boolean {
  return tags.drinking_water === "no";
}

// The survey asks one question at a time, so a runner glancing down mid-run
// only ever weighs two answers: working or not; if not, gone or broken; if
// broken, how badly. "Working" records at once; each other leaf opens that
// action's details form.
type Step = "choose" | "problem" | "broken";

const STEP_TITLE: Record<Exclude<Step, "choose">, string> = {
  problem: "What's Wrong?",
  broken: "How Broken Is It?",
};

// The details form behind each answer: its title, and its submit button.
// Amber takes dark ink: white on it is about 2:1, too faint to read at a
// glance mid-run.
const FORMS: Record<
  SurveyAction,
  { title: string; label: string; Icon: typeof CheckCircleIcon; box: string; ink?: Ink }
> = {
  confirm: {
    title: "Working",
    label: "Confirm Working",
    Icon: CheckCircleIcon,
    box: "bg-green-600",
  },
  broken: {
    title: "Partially Working",
    label: "Mark Partially Working",
    Icon: DropHalfIcon,
    box: "bg-amber-500",
    ink: "dark",
  },
  out_of_order: {
    title: "Out of Order",
    label: "Mark Out of Order",
    Icon: DropSlashIcon,
    box: "bg-orange-600",
  },
  removed: {
    title: "No Fountain",
    label: "Confirm No Fountain",
    Icon: TrashIcon,
    box: "bg-red-600",
  },
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
  // A rarer answer: a standard-height button, so it can't be mistaken for, or
  // hit instead of, the common one beside it.
  compact?: boolean;
};

// A full-width answer, tall enough to hit one-handed mid-run.
function ChoiceButton({ title, Icon, onPress, box, ink = "light", compact }: ChoiceButtonProps) {
  const fg = box ? INK[ink] : { text: "text-red-700", hex: "#b91c1c" };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      className={`flex-row items-center justify-center gap-2 rounded-2xl px-4 active:opacity-70 ${
        compact ? "py-3" : "py-7"
      } ${box ?? "border-2 border-red-600"}`}
    >
      <Icon size={compact ? 20 : 28} color={fg.hex} weight="bold" />
      <Text className={`text-center font-bold ${compact ? "text-base" : "text-xl"} ${fg.text}`}>
        {title}
      </Text>
    </Pressable>
  );
}

// The sheet's own top bar: the standard back chevron on the leading edge
// (HIG: Toolbars, "don't use a text label that says Back"; Sheets, Back
// replaces Cancel there in a multi-step flow) and what this step is for.
function SheetHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View className="min-h-11 flex-row items-center gap-1">
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          className="-ml-2 h-11 w-11 items-center justify-center rounded-full active:bg-black/5"
        >
          <CaretLeftIcon size={24} color="#0c0d0a" weight="bold" />
        </Pressable>
      ) : null}
      <Text
        accessibilityRole="header"
        className="flex-1 text-base text-xl font-bold"
        numberOfLines={2}
      >
        {title}
      </Text>
    </View>
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
  // Offered while the shown edit can still be taken back. A screen that keeps
  // more state than the outbox (the run's stop statuses) handles Undo itself
  // and leaves this out.
  onUndo?: (edit: PointEdit) => void;
  inRoute?: boolean;
  onToggleRoute?: () => void;
  // Open on the survey questions even though an edit is on record: the run
  // stepped back to this stop so it can be answered again.
  reask?: boolean;
};

export function PointSheet({
  fountain,
  edit,
  onAction,
  onUndo,
  inRoute,
  onToggleRoute,
  reask = false,
}: Props) {
  const tags = fountain.tags ?? {};
  // A point not in OSM yet (run.tsx's add sheet passes id -1, OSM's mark for an
  // object still to be created).
  const isNew = fountain.id < 0;
  const signedIn = useSignedIn();
  const [step, setStep] = useState<Step>("choose");
  // The step stays put while a form is open, so the form's Back lands on the
  // step it was opened from.
  const [detailFor, setDetailFor] = useState<SurveyAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set synchronously, so a second tap before the re-render can't submit twice.
  const inFlight = useRef(false);
  // An edit was just saved from this sheet, so its card should announce it.
  // A card for an edit from an earlier visit just shows.
  const [justSaved, setJustSaved] = useState(false);
  // Answering again over the edit on record. The new answer is queued after
  // the old one, or replaces it while it can still be undone (see submit).
  const [revising, setRevising] = useState(reask);

  const [prevId, setPrevId] = useState(fountain.id);
  if (prevId !== fountain.id) {
    setPrevId(fountain.id);
    setStep("choose");
    setDetailFor(null);
    setFailure(null);
    setJustSaved(false);
    setRevising(reask);
  }

  // Undo is shown until the edit's hold ends, then goes by itself.
  const undoUntil = onUndo && edit?.syncState === "pending" ? edit.undoUntil : undefined;
  const [undoOpen, setUndoOpen] = useState(false);
  useEffect(() => {
    const left = undoUntil ? undoUntil - Date.now() : 0;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the edit; the timer closes it
    setUndoOpen(left > 0);
    if (left <= 0) return;
    const t = setTimeout(() => setUndoOpen(false), left);
    return () => clearTimeout(t);
  }, [undoUntil]);

  // What OSM says about the point, shown over the survey steps only: the forms
  // and the recorded edit say what is being or was just recorded, which this
  // line would contradict. A new point gets no line at all: its tags are only
  // the defaults it was handed, so the line would report a state nobody
  // mapped. The label needn't tick while the sheet is up.
  const [now] = useState(() => Date.now());
  const statusLine = isNew ? null : pointStatusLine(tags, now);

  const submit = async (action: SurveyAction, extras?: EditExtras) => {
    if (inFlight.current) return;
    // Recording again while the last record can still be taken back replaces
    // it, instead of queueing two edits for the one visit.
    if (edit?.id && edit.undoUntil && edit.undoUntil > Date.now()) {
      useOutbox.getState().cancel(edit.id);
    }
    const result = onAction(action, extras);
    if (result instanceof Promise) {
      inFlight.current = true;
      setSaving(true);
      setFailure(null);
      try {
        await result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setFailure(message);
        announce(message);
        return;
      } finally {
        inFlight.current = false;
        setSaving(false);
      }
    }
    setDetailFor(null);
    setStep("choose");
    setRevising(false);
    setJustSaved(true);
  };

  // The most common answer, in one tap: what the details form would send
  // untouched. A node whose recorded note the server would refuse opens the
  // form instead, so the note can be shortened.
  const answerWorking = () => {
    const result = surveyExtras("confirm", surveyFormDefaults(tags));
    if (!result.ok) {
      setDetailFor("confirm");
      return;
    }
    void submit("confirm", result.extras);
  };

  const fountainTitle = tags.name ?? (isNew ? "New Fountain" : "Fountain");

  // A new fountain goes straight to its details: "is it working?" has nothing
  // to ask about something being added, and "No Fountain" would make no sense.
  const form: SurveyAction | null = isNew ? "confirm" : detailFor;
  const formSpec = isNew
    ? { ...FORMS.confirm, title: "New Fountain", label: "Add Fountain", Icon: PlusCircleIcon }
    : form
      ? FORMS[form]
      : null;

  // The survey questions show with no edit on record, or while answering again.
  const asking = !edit || revising;

  // Header: the form's or step's title with a way back, else the fountain.
  const header = isNew
    ? { title: fountainTitle, onBack: undefined }
    : detailFor
      ? {
          title: FORMS[detailFor].title,
          onBack: () => {
            setDetailFor(null);
            setFailure(null);
          },
        }
      : asking && step !== "choose"
        ? {
            title: STEP_TITLE[step],
            onBack: () => setStep(step === "broken" ? "problem" : "choose"),
          }
        : edit && revising
          ? { title: "Change Answer", onBack: () => setRevising(false) }
          : { title: fountainTitle, onBack: undefined };

  return (
    <View className="gap-4 px-1 py-1">
      <SheetHeader title={header.title} onBack={header.onBack} />

      {!form && isDogWater(tags) ? (
        <View className="flex-row items-center gap-1.5 self-start rounded-lg border border-violet-300 bg-violet-100 px-2.5 py-1">
          <DogIcon size={14} color="#5b21b6" />
          <Text className="text-sm font-bold text-violet-950">Dog water — not for humans</Text>
        </View>
      ) : null}

      {onToggleRoute && !form ? (
        <Pressable
          onPress={onToggleRoute}
          accessibilityRole="button"
          className={`flex-row items-center justify-center gap-2 rounded-full px-5 py-4 active:opacity-70 ${
            inRoute ? "border-2 border-red-600" : "bg-green-600"
          }`}
        >
          <Text className={`text-lg font-bold ${inRoute ? "text-red-700" : "text-white"}`}>
            {inRoute ? "Remove from Route" : "Add to Route"}
          </Text>
        </Pressable>
      ) : null}

      {form && formSpec ? (
        <>
          <PointDetailsForm
            kind={form}
            tags={tags}
            submitLabel={formSpec.label}
            SubmitIcon={formSpec.Icon}
            submitBox={formSpec.box}
            submitInk={formSpec.ink}
            onSubmit={(extras) => void submit(form, extras)}
          />
          {saving ? (
            <Text className="text-muted text-callout font-semibold">Saving…</Text>
          ) : failure ? (
            <Text className="text-callout font-semibold text-red-700">{failure}</Text>
          ) : null}
        </>
      ) : edit && !revising ? (
        // Keyed on the edit, so a second save from this sheet pops again.
        <PopIn animate={justSaved} trigger={edit.id}>
          <View className="border-border bg-surface-deep gap-2 rounded-2xl border p-4">
            {/* A green check whatever the answer: it says the report was saved,
              not that the fountain is fine. */}
            <View className="flex-row items-center gap-2">
              <PopIn animate={justSaved} trigger={edit.id} from={0.3}>
                <CheckCircleIcon size={24} color={EDIT_COLOR.confirm} weight="fill" />
              </PopIn>
              <Text className="flex-1 text-base text-lg font-bold">
                {STATUS_LABEL[edit.status]}
              </Text>
            </View>
            {edit.extras?.seasonal ? (
              <View className="flex-row items-center gap-1">
                <SnowflakeIcon size={16} color="#0369a1" />
                <Text className="text-sm font-bold text-sky-800">Seasonal</Text>
              </View>
            ) : null}
            {edit.extras?.note ? (
              <Text className="text-base text-sm font-medium italic">“{edit.extras.note}”</Text>
            ) : null}
            <View className="mt-0.5 flex-row flex-wrap items-center gap-x-4 gap-y-2">
              <Text className="text-muted text-sm font-semibold">{syncLabel(edit, signedIn)}</Text>
              {edit.syncState === "failed" ? (
                <Pressable
                  onPress={() => void useOutbox.getState().retryAll()}
                  accessibilityRole="button"
                  accessibilityLabel="Try sending again"
                  hitSlop={12}
                >
                  <Text className="text-action text-sm font-bold">Try Again</Text>
                </Pressable>
              ) : null}
              {undoOpen && onUndo ? (
                <Pressable
                  onPress={() => {
                    hapticSelect();
                    onUndo(edit);
                    announce("Undone.");
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Undo ${STATUS_LABEL[edit.status].toLowerCase()}`}
                  hitSlop={12}
                >
                  <Text className="text-action text-sm font-bold">Undo</Text>
                </Pressable>
              ) : null}
              {edit.status !== "removed" ? (
                <Pressable
                  onPress={() => setDetailFor(edit.status)}
                  accessibilityRole="button"
                  hitSlop={12}
                >
                  <Text className="text-action text-sm font-bold">Add Details</Text>
                </Pressable>
              ) : null}
              {/* A wrong tap must stay fixable after Undo's few seconds are
                  up. The new answer is sent after the old one, so it is what
                  the map ends up with (inside the hold, submit drops the old
                  one instead). */}
              <Pressable
                onPress={() => {
                  setStep("choose");
                  setRevising(true);
                }}
                accessibilityRole="button"
                hitSlop={12}
              >
                <Text className="text-action text-sm font-bold">Change Answer</Text>
              </Pressable>
            </View>
            {edit.changesetUrl ? (
              <Pressable
                onPress={() => Linking.openURL(edit.changesetUrl!)}
                accessibilityRole="link"
                hitSlop={12}
                className="mt-0.5 flex-row items-center gap-1 self-start"
              >
                <ArrowSquareOutIcon size={16} color="#1877a3" />
                <Text className="text-action text-sm font-bold">View Online</Text>
              </Pressable>
            ) : null}
            {/* An edit made signed out waits on the phone; this is the moment
              sign-in is worth asking for (HIG: Managing accounts). */}
            {!signedIn && edit.syncState === "pending" ? (
              <View className="border-border mt-2 gap-3 border-t pt-3">
                <Text className="text-muted text-sm">
                  Sign in to send your updates to OpenStreetMap, the free public map Water Run saves
                  to. They stay on this phone until then.
                </Text>
                <SignInButton />
              </View>
            ) : null}
          </View>
        </PopIn>
      ) : (
        <View className="gap-4 py-1">
          {/* What the map said before this visit; while answering again it
              would contradict the answer on record. */}
          {statusLine && step === "choose" && !revising ? (
            <Text className="text-muted text-callout">{statusLine}</Text>
          ) : null}
          {step === "choose" ? (
            <>
              <ChoiceButton
                title="Working"
                Icon={CheckCircleIcon}
                box="bg-green-600"
                onPress={answerWorking}
              />
              {/* Purple: a hue none of the answers behind it (red, orange,
                  amber) use, so this step and the next never look alike. */}
              <ChoiceButton
                title="Problem"
                Icon={WarningIcon}
                box="bg-violet-700"
                onPress={() => setStep("problem")}
              />
            </>
          ) : step === "problem" ? (
            <>
              {/* Broken is the usual answer, so it leads at full size; No
                  Fountain is rarer and sits under it, smaller. */}
              <ChoiceButton
                title="Broken"
                Icon={WrenchIcon}
                box="bg-orange-600"
                onPress={() => setStep("broken")}
              />
              <ChoiceButton
                title="No Fountain"
                Icon={TrashIcon}
                compact
                onPress={() => setDetailFor("removed")}
              />
            </>
          ) : (
            <>
              <ChoiceButton
                title="Partially Working"
                Icon={DropHalfIcon}
                box="bg-amber-500"
                ink="dark"
                onPress={() => setDetailFor("broken")}
              />
              <ChoiceButton
                title="Totally Out of Order"
                Icon={DropSlashIcon}
                box="bg-orange-600"
                onPress={() => setDetailFor("out_of_order")}
              />
            </>
          )}
          {saving ? <Text className="text-muted text-callout font-semibold">Saving…</Text> : null}
        </View>
      )}
    </View>
  );
}
