import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useRun, type RunStop, type StopStatus } from "@water-run/core/stores/run";
import { createKey, useProposals, type ProposedItem } from "@water-run/core/stores/proposals";
import {
  runGuidance,
  guidanceWindow,
  ARRIVAL_RADIUS_M,
  PROXIMITY_RADIUS_M,
} from "@water-run/core/guidance";
import { compass, type Pt } from "@water-run/core/geo";
import { runCue } from "@water-run/core/runCue";
import { ptLabel } from "@water-run/core/pointTypes";
import { STATUS_COLOR } from "@water-run/core/editStatus";
import { activeRunToResume, archiveRun, beginRun } from "@water-run/core/runLifecycle";
import { isHomeLeg, isRunOver } from "@water-run/core/runLegs";
import type { Turn } from "@water-run/core/brouter";
import type { EditAction, EditExtras, Fountain } from "@water-run/core/schemas";
import type { SurveyAction } from "../components/PointSheet";
import { useOsmStatus } from "../auth/useOsmStatus";
import { trackRun, type TrackingError } from "../tasks/runLocationTask";
import { hapticImpact, hapticSelect, hapticSuccess } from "../ports/haptics";
import { announce } from "../ports/accessibility";
import { keepAwake, allowSleep } from "../ports/keepAwake";
import { celebratePoint } from "../ports/confetti";
import { ensureNotifyPermission, notifyProximity, notifyRunComplete } from "../ports/notify";
import { showRunProgress, endRunProgress } from "../ports/runProgress";
import type { MapMarker } from "../map/WaterRunMap";

// Human-facing confirmation shown after a save. No raw OSM tags reach the UI.
const SAVED_LABEL: Record<SurveyAction, string> = {
  confirm: "Working",
  broken: "Partially working",
  out_of_order: "Out of order",
  removed: "Removed",
};

// The start's marker on the way back. Not a point: nothing opens on a tap.
export const START_MARKER_ID = "start";

// No turns to give: see offRoute below.
const NO_TURNS: Turn[] = [];

// The last update recorded, for the panel's "Saved" line and its Undo: what
// to put back in the run's held updates, and what to put the run back to.
// Nothing has left the phone (updates are sent after the run's review), so
// Undo is offered until the next action.
type LastSaved = {
  nodeId: number;
  label: string;
  undo?: {
    key: string; // the held update this record wrote
    previous?: ProposedItem; // what it replaced, if anything
    createdId?: number; // a point added on the spot: taken off the run too
    index: number; // where the run stood before the record
    status: StopStatus | undefined; // the stop's status before it
  };
};

// Said when an update couldn't be written to the phone's storage (it's full).
// It is still held in memory, so it goes out with the run unless the app dies.
const NOT_STORED =
  "This update couldn't be saved to the phone's storage. Keep the app open until you've sent your run.";

// The Expo run session: live GPS, the shared guidance derived from it, the OSM
// recording actions, and marker DATA for WaterRunMap. Mirrors the web useRunSession
// but returns markers as plain data (the screen owns the bottom sheet). Ending
// the run is run/runLifecycle's endRun, not part of the session.
export function useRunSession({
  enabled = true,
  onArrive,
}: {
  enabled?: boolean;
  // The runner just came within the arrival radius of the stop they're
  // heading for. Called once per stop, while the app is in the foreground.
  onArrive?: (stop: RunStop) => void;
} = {}) {
  const run = useRun();
  const { status: osm } = useOsmStatus();
  const [pos, setPos] = useState<Pt | null>(null);
  const [manualArrived, setManualArrived] = useState(false);
  const [err, setErrState] = useState<string | null>(null);
  // Whether the error is a location denial only Settings can undo.
  const [locationDenied, setLocationDenied] = useState(false);
  // Errors appear over the map, so VoiceOver is told as well.
  const setErr = useCallback((message: string | null) => {
    setErrState(message);
    if (message) announce(message);
  }, []);
  const [hydrating, setHydrating] = useState(() => enabled && !useRun.getState().hasPlan);
  const [nothingToResume, setNothingToResume] = useState(false);
  const [lastSaved, setLastSaved] = useState<LastSaved | null>(null);

  // Cold start (/run reached with no run in memory, e.g. by a link): pick the
  // active run back up by its id and under that id, so its archive entry keeps
  // being the one updated. A finished run, or none, is nothing to resume.
  useEffect(() => {
    if (!enabled || useRun.getState().hasPlan) return;
    Promise.resolve().then(() => {
      const saved = activeRunToResume();
      if (saved) useRun.getState().hydrate(saved);
      else setNothingToResume(true);
      setHydrating(false);
    });
  }, [enabled]);

  // Mark the run active, then follow it: the background location task, which
  // runs only while a run is active and a screen listens (see
  // tasks/runLocationTask).
  const { hasPlan, routeId } = run;
  useEffect(() => {
    if (!enabled || !hasPlan) return;
    beginRun();
    let live = true;
    const watch = trackRun(
      (p) => {
        setPos({ lat: p.lat, lon: p.lon });
        setLocationDenied(false);
      },
      (e: TrackingError) => {
        setErr(e.message);
        setLocationDenied(!!e.denied);
      },
    );
    // The lock-screen updates need notifications, asked for only once the
    // location prompt is over, so the two system prompts never stack.
    void watch.settled.then(() => {
      if (live) void ensureNotifyPermission();
    });
    return () => {
      live = false;
      watch.clear();
    };
  }, [enabled, hasPlan, routeId, setErr]);

  // Keep the screen awake while armed.
  useEffect(() => {
    if (!enabled) return;
    keepAwake();
    return () => allowSleep();
  }, [enabled]);

  const { stops, index, tagKey, tagValue, added, pool, routeCoords, turns, start } = run;
  const addLabel = ptLabel(tagKey, tagValue);
  const target: RunStop | undefined = stops[index];
  // A loop isn't over at its last stop: its last leg is back to the start, and
  // the run is done only once the runner gets there (see core's runLegs).
  const homeward = hasPlan && isHomeLeg(run);
  const done = hasPlan && isRunOver(run);
  // Where the runner is heading: the next stop, or on the way back the start.
  const goal: Pt | undefined = target ?? (homeward ? start : undefined);
  // A route ended early leaves stops unreached, and the runner heads back from
  // wherever they are, off the route: its turns would lead on through those
  // stops, so the way back is just the start's distance and direction.
  const offRoute = homeward && stops.some((st) => st.status === "pending");

  // The stretch of route between the previous stop and this one, so the
  // guidance doesn't latch onto another pass of a route that doubles back.
  // Changes only with the stop, not with each fix.
  const stretch = useMemo(
    () => guidanceWindow(routeCoords, stops, index),
    [routeCoords, stops, index],
  );
  const { distToTarget, bearingTo, nextTurn, distToTurn, autoArrived } = runGuidance(
    pos,
    goal ?? null,
    routeCoords,
    offRoute ? NO_TURNS : turns,
    stretch,
  );
  const heading = goal ? compass(bearingTo) : "";
  const arrived = manualArrived || autoArrived;
  // What the panel leads with: distance, direction, and the next turn before
  // the stop (a turn past it belongs to the next leg).
  const cue = goal
    ? runCue({
        distToTargetM: distToTarget,
        bearingTo,
        nextTurn,
        distToTurnM: distToTurn,
        stopAlongM: stretch?.[1],
      })
    : null;

  // Proximity cue, once per target within the proximity band: a haptic (felt
  // without looking) while the app is open, a notification while it isn't
  // (notifyProximity skips the foreground).
  const notifiedProxRef = useRef<number>(-1);
  useEffect(() => {
    if (!enabled || !target || distToTarget == null) return;
    if (
      distToTarget < PROXIMITY_RADIUS_M &&
      distToTarget >= ARRIVAL_RADIUS_M &&
      notifiedProxRef.current !== index
    ) {
      notifiedProxRef.current = index;
      const name = target.tags?.name || `Stop ${index + 1}`;
      if (AppState.currentState === "active") {
        hapticImpact();
        announce(`${name} is close.`);
      } else {
        notifyProximity(name, distToTarget);
      }
    }
  }, [enabled, target, distToTarget, index]);

  // Arrival, once per stop: the runner is there, so the screen can put the
  // survey in front of them without a tap.
  const onArriveRef = useRef(onArrive);
  useEffect(() => {
    onArriveRef.current = onArrive;
  });
  const arrivedForRef = useRef<number>(-1);
  useEffect(() => {
    if (!enabled || !target || !autoArrived || arrivedForRef.current === index) return;
    arrivedForRef.current = index;
    if (target.status !== "pending" || AppState.currentState !== "active") return;
    hapticSuccess();
    announce(`Arrived at ${target.tags?.name || `stop ${index + 1}`}.`);
    onArriveRef.current?.(target);
  }, [enabled, target, autoArrived, index]);

  // The run's progress on the lock screen: a Live Activity, or the notification
  // line where there is none. Handed every fix; each decides whether it's worth
  // an update. It follows the runner back to the start, and is taken down once
  // the run is done, and when the run leaves the screen.
  useEffect(() => {
    if (!enabled) return;
    if (!goal) {
      endRunProgress();
      return;
    }
    if (distToTarget == null) return;
    showRunProgress({
      stopKey: target ? `${index}:${target.id}` : "start",
      stopName: target ? target.tags?.name || `Stop #${index + 1}` : "Start",
      stopNumber: index + 1,
      totalStops: stops.length,
      homeward: !target,
      distToStopM: distToTarget,
      nextTurn,
      distToTurnM: distToTurn,
    });
  }, [enabled, goal, target, distToTarget, index, stops.length, nextTurn, distToTurn]);
  useEffect(() => {
    if (!enabled) return;
    return () => endRunProgress();
  }, [enabled]);

  const notifiedDoneRef = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    if (done && !notifiedDoneRef.current) {
      notifiedDoneRef.current = true;
      const surveyed = stops.filter((s) => s.status !== "pending" && s.status !== "skipped").length;
      notifyRunComplete(surveyed);
      // The run's one celebration: per-stop records get a haptic and the
      // panel's Saved line, not motion on every stop (HIG: Motion).
      if (surveyed > 0) celebratePoint();
      announce(`Route complete. ${surveyed} of ${stops.length} points surveyed.`);
    }
    if (!done) notifiedDoneRef.current = false;
  }, [enabled, done, stops]);

  const advance = useCallback(() => {
    const ni = index + 1;
    run.setIndex(ni);
    setManualArrived(false);
    archiveRun(ni);
  }, [index, run]);

  // Back at the start: the loop is run. Wherever the app is, unlike a stop's
  // arrival, since nothing here needs an answer from the runner, and with the
  // app in the background the run's completion reaches them as a notification.
  // Not once per leg, as a stop's arrival is: a runner who undoes their last
  // record and makes it again is back on this leg, and still at the start.
  // Only the run store moves on: every way onto this leg already cleared
  // manualArrived, so advance()'s reset of it would have nothing to do.
  useEffect(() => {
    if (!enabled || !homeward || !autoArrived) return;
    hapticSuccess();
    announce("Back at the start.");
    run.setIndex(index + 1);
    archiveRun(index + 1);
  }, [enabled, homeward, autoArrived, index, run]);

  // On the way back, end the run short of the start: the runner stopped
  // nearby, or GPS can't place them there.
  const finishHere = useCallback(() => {
    if (!homeward) return;
    setLastSaved(null);
    advance();
  }, [homeward, advance]);

  const recordFor = useCallback(
    (node: Fountain, action: SurveyAction, extras?: EditExtras) => {
      setErr(null);
      const proposals = useProposals.getState();
      // A point added on this run isn't on OSM yet: its held create takes the
      // new details, or goes if the point turned out not to be there.
      if (node.id < 0) {
        const key = createKey(node.id);
        if (action === "removed") {
          proposals.remove(routeId, key);
          run.removeNode(node.id);
        } else if (!proposals.update(routeId, key, { extras })) {
          setErr(NOT_STORED);
        }
        hapticSuccess();
        announce("Saved.");
        setLastSaved(null);
        archiveRun(index);
        return;
      }
      const isCurrent = !!target && node.id === target.id;
      const before = stops.find((st) => st.id === node.id)?.status;
      const { saved, item, previous } = proposals.record(routeId, {
        nodeId: node.id,
        action,
        tagKey,
        name: node.tags?.name,
        extras,
        point: { lat: node.lat, lon: node.lon, tags: node.tags ?? {} },
      });
      if (!item) {
        setErr("This run's updates have already been sent.");
        return;
      }
      if (!saved) setErr(NOT_STORED);
      run.setStatus(node.id, action as RunStop["status"]);
      hapticSuccess();
      announce(`Saved: ${SAVED_LABEL[action]}.`);
      setLastSaved({
        nodeId: node.id,
        label: SAVED_LABEL[action],
        undo: { key: item.key, previous, index, status: before },
      });
      // advance() archives the run at the next stop; a node off the current
      // stop is archived where the run stands.
      if (isCurrent) advance();
      else archiveRun(index);
    },
    [target, tagKey, run, routeId, index, advance, stops, setErr],
  );

  // Undo is on offer for the last record until the next action.
  const undoOpen = !!lastSaved?.undo;

  // Take the last record back: the held update returns to what it was (or
  // goes), and the run returns to that stop as it was.
  const undoLast = useCallback(() => {
    const u = lastSaved?.undo;
    if (!u) return;
    const proposals = useProposals.getState();
    if (u.previous) proposals.put(routeId, u.previous);
    else proposals.remove(routeId, u.key);
    if (u.createdId !== undefined) run.removeNode(u.createdId);
    if (u.status !== undefined) run.setStatus(lastSaved!.nodeId, u.status);
    run.setIndex(u.index);
    setManualArrived(false);
    archiveRun(u.index);
    setLastSaved(null);
    hapticSelect();
    announce("Undone.");
  }, [lastSaved, run, routeId]);

  const record = useCallback(
    (action: EditAction, extras?: EditExtras) => {
      if (target) recordFor(target, action, extras);
    },
    [target, recordFor],
  );

  const skip = useCallback(() => {
    setLastSaved(null);
    if (target) run.setStatus(target.id, "skipped");
    advance();
  }, [target, run, advance]);

  // Step back to the previous stop and re-open it for action. Resets that stop's
  // status to pending so the arrival actions show again. Its held update stays
  // until a re-record replaces it (one update per point), and the run's end
  // puts the stop's status back from it. No-op at the first stop.
  const goBack = useCallback(() => {
    if (index <= 0) return;
    const pi = index - 1;
    setLastSaved(null);
    setManualArrived(false);
    run.setStatus(stops[pi].id, "pending");
    run.setIndex(pi);
    archiveRun(pi);
  }, [index, stops, run]);

  // Add a brand-new point of the surveyed type at a given spot (GPS position
  // or a held map location). Held with the run's other updates and created on
  // OSM in the same upload, so it needs no connection or sign-in now, and a
  // lost reply can't add it twice. The run shows it under its placeholder id
  // until then.
  const addAt = useCallback(
    async (at: { lat: number; lon: number }, extras?: EditExtras): Promise<void> => {
      setErr(null);
      const { saved, item } = useProposals.getState().addCreate(routeId, {
        lat: at.lat,
        lon: at.lon,
        tag: { key: tagKey, value: tagValue },
        extras,
      });
      if (!item) throw new Error("This run's updates have already been sent.");
      if (!saved) setErr(NOT_STORED);
      run.addNode({ id: item.tempId, lat: at.lat, lon: at.lon, tags: { [tagKey]: tagValue } });
      celebratePoint();
      hapticSuccess();
      setLastSaved({
        nodeId: item.tempId,
        label: "Added",
        undo: { key: item.key, createdId: item.tempId, index, status: undefined },
      });
      announce("Fountain added.");
      archiveRun(index);
    },
    [tagKey, tagValue, run, routeId, index, setErr],
  );

  const addHere = useCallback(async () => {
    if (!pos) {
      setErr("Waiting for GPS fix.");
      return;
    }
    await addAt(pos).catch((e: Error) => setErr(e.message));
  }, [pos, addAt, setErr]);

  // The panel's error line, for a failure whose own UI has gone: an add whose
  // sheet was swiped away while it saved.
  const reportError = useCallback((message: string) => setErr(message), [setErr]);

  // Leave the stops still ahead for next time. On a loop that's the way back to
  // the start (the run still ends there); on a one-way route the run is over.
  const endEarly = useCallback(() => {
    setLastSaved(null);
    setManualArrived(false);
    run.setIndex(stops.length);
    archiveRun(stops.length);
  }, [stops.length, run]);

  const line: [number, number][] = useMemo(
    () => routeCoords.map(([lon, lat]) => [lat, lon]),
    [routeCoords],
  );

  const markers: MapMarker[] = useMemo(() => {
    const onRoute = new Set(stops.map((s) => s.id));
    const stopMarkers: MapMarker[] = stops.map((s, i) => ({
      id: s.id,
      lat: s.lat,
      lon: s.lon,
      color: i === index && s.status === "pending" ? "#2563eb" : STATUS_COLOR[s.status],
      label: String(i + 1),
    }));
    const addedMarkers: MapMarker[] = added.map((f) => ({
      id: f.id,
      lat: f.lat,
      lon: f.lon,
      color: "#16a34a",
      label: "+",
    }));
    const dimMarkers: MapMarker[] = pool
      .filter((f) => !onRoute.has(f.id))
      .map((f) => ({ id: f.id, lat: f.lat, lon: f.lon, color: "#9ca3af", dimmed: true }));
    // On the way back, the start is the target, marked as a stop being headed
    // for is.
    const startMarker: MapMarker[] = homeward
      ? [{ id: START_MARKER_ID, lat: start.lat, lon: start.lon, color: "#2563eb" }]
      : [];
    return [...dimMarkers, ...stopMarkers, ...addedMarkers, ...startMarker];
  }, [stops, index, added, pool, homeward, start]);

  // Where the map opens before there is a fix to frame.
  const center: [number, number] = pos
    ? [pos.lat, pos.lon]
    : target
      ? [target.lat, target.lon]
      : [run.start.lat, run.start.lon];

  // What the map keeps in view: the runner and where they're heading (a stop,
  // or the start on the way back), or just the runner once the run is done.
  // The map refits as these move (until the user takes the camera), so they
  // change only with a fix or a new leg.
  const fitPoints = useMemo((): [number, number][] | undefined => {
    if (!pos) return undefined;
    return goal
      ? [
          [pos.lat, pos.lon],
          [goal.lat, goal.lon],
        ]
      : [[pos.lat, pos.lon]];
  }, [pos, goal]);

  return {
    markers,
    line,
    center,
    fitPoints,
    // A fix has come in, so location is permitted and the map's own puck
    // (which follows the device by itself) can be shown.
    located: pos !== null,
    pos,
    cue,
    locationDenied,
    hydrating,
    nothingToResume,
    loop: run.loop,
    homeward,
    offRoute,
    done,
    routeId,
    stops,
    index,
    target,
    distToTarget,
    heading,
    nextTurn,
    distToTurn,
    arrived,
    addLabel,
    added,
    pool,
    osm,
    err,
    lastSaved,
    undoOpen,
    undoLast,
    setManualArrived,
    recordFor,
    record,
    skip,
    goBack,
    endEarly,
    finishHere,
    addHere,
    addAt,
    reportError,
  };
}

export type RunSession = ReturnType<typeof useRunSession>;
