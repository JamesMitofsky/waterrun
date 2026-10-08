import { AppState, Platform, type NativeEventSubscription } from "react-native";
import * as Notifications from "expo-notifications";
import { metersToFeet } from "@water-run/core/geo";
import {
  shouldPostProgress,
  type PostedProgress,
  type ProgressLine,
} from "@water-run/core/runProgress";

// The run's progress line (see showRunProgress). The identifier is the one
// earlier builds posted it under, so ending a run also clears one they left.
const PROGRESS_ID = "live_activity";
// Android: the progress line's own low-importance channel, so its updates are
// silent and never peek. A new id on purpose: once a device has created a
// channel, its importance can't be lowered.
const PROGRESS_CHANNEL = "run-progress";

// Show run alerts as banners even when the app is foregrounded. The progress
// line never banners: in the app, the run screen already shows it.
Notifications.setNotificationHandler({
  handleNotification: async (n) => ({
    shouldShowBanner: n.request.identifier !== PROGRESS_ID,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const holder = { asked: false, granted: false };

export async function ensureNotifyPermission(): Promise<boolean> {
  if (holder.asked) return holder.granted;
  holder.asked = true;
  const { status } = await Notifications.requestPermissionsAsync();
  holder.granted = status === "granted";
  return holder.granted;
}

async function fire(id: string, title: string, body: string): Promise<void> {
  if (!holder.granted && !(await ensureNotifyPermission())) return;
  await Notifications.scheduleNotificationAsync({
    identifier: id,
    content: { title, body },
    trigger: null,
  });
}

export function notifyProximity(name: string, meters: number): void {
  void fire(
    "prox",
    "Survey point ahead",
    `${name} — about ${Math.round(metersToFeet(meters))} ft away.`,
  );
}

export function notifyRunComplete(count: number): void {
  void fire("done", "Run complete", `You surveyed ${count} ${count === 1 ? "point" : "points"}.`);
}

export function notifySyncPending(count: number): void {
  void fire(
    "sync",
    "Edits uploading",
    `Sending your ${count} pending ${count === 1 ? "edit" : "edits"}.`,
  );
}

// -- The progress line --------------------------------------------------------
// A stand-in for a Live Activity: the run's next stop and turn, kept up to date
// while the app is in the background (screen locked, another app in front).
// Only then: in the app the run screen shows the same. A notification is an
// alert surface, so posts are throttled and deduplicated by shouldPostProgress
// and made quiet: a passive interruption level on iOS (no sound, the screen
// stays dark) and a silent low-importance channel on Android.

let latest: ProgressLine | null = null;
let posted: PostedProgress | null = null;
let appState: NativeEventSubscription | null = null;

// Posts and dismissals run in call order, so a dismissal can't land before a
// post still on its way and leave that post showing.
let queue: Promise<unknown> = Promise.resolve();
const inOrder = (step: () => Promise<unknown>) => {
  queue = queue.then(step).catch(() => {});
};

let channel: Promise<unknown> | null = null;
function progressChannel(): Promise<unknown> {
  // A post to a channel that doesn't exist goes to expo-notifications' own
  // high-importance fallback channel, so this one must exist first.
  channel ??= Notifications.setNotificationChannelAsync(PROGRESS_CHANNEL, {
    name: "Run progress",
    description: "Distance to your next survey point and turn during a run.",
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
    enableVibrate: false,
    showBadge: false,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  }).catch(() => {
    channel = null;
  });
  return channel;
}

function post(): void {
  if (!latest || !holder.granted || AppState.currentState !== "background") return;
  const now = Date.now();
  if (!shouldPostProgress(posted, latest, now)) return;
  const line = latest;
  posted = { ...line, atMs: now };
  inOrder(async () => {
    if (Platform.OS === "android") await progressChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: PROGRESS_ID,
      content: {
        title: "Next Fountain",
        body: line.body,
        sound: false,
        interruptionLevel: "passive",
      },
      // Posted at once on that channel; iOS has no channels and ignores it.
      trigger: { channelId: PROGRESS_CHANNEL },
    });
  });
}

function dismiss(): void {
  posted = null;
  inOrder(() => Notifications.dismissNotificationAsync(PROGRESS_ID));
}

// Back in the app the line is redundant, so it goes; going to the background
// posts it straight away.
function onAppState(next: string): void {
  if (next === "active") dismiss();
  else post();
}

// Hand over the run's latest progress; called on every fix. Cheap: it posts
// only when the line is worth it.
export function showRunProgress(line: ProgressLine): void {
  latest = line;
  appState ??= AppState.addEventListener("change", onAppState);
  post();
}

// The run ended or left the screen: take the line down. Safe to call any time,
// including at launch to clear one left by a run the app didn't get to end.
export function endRunProgress(): void {
  appState?.remove();
  appState = null;
  latest = null;
  dismiss();
}
