import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRun, type RunStop } from "@rosm/core/stores/run";
import { useOutbox } from "@rosm/core/stores/outbox";
import {
  runGuidance,
  guidanceWindow,
  ARRIVAL_RADIUS_M,
  PROXIMITY_RADIUS_M,
} from "@rosm/core/guidance";
import { compass, type Pt } from "@rosm/core/geo";
import { ptLabel } from "@rosm/core/pointTypes";
import { STATUS_COLOR } from "@rosm/core/editStatus";
import { todayLocal } from "@rosm/core/editSummary";
import { callApi, postJson, UNEXPECTED_REPLY } from "@rosm/core/apiCall";
import { activeRunToResume, archiveRun, beginRun } from "@rosm/core/runLifecycle";
import { progressLine } from "@rosm/core/runProgress";
import type { EditAction, EditExtras, Fountain } from "@rosm/core/schemas";
import type { SurveyAction } from "../components/PointSheet";
import { getToken } from "../auth/authStore";
import { useOsmStatus } from "../auth/useOsmStatus";
import { trackRun } from "../tasks/runLocationTask";
import { hapticSuccess } from "../ports/haptics";
import { keepAwake, allowSleep } from "../ports/keepAwake";
import { celebratePoint } from "../ports/confetti";
import {
  ensureNotifyPermission,
  notifyProximity,
  notifyRunComplete,
  showRunProgress,
  endRunProgress,
} from "../ports/notify";
import type { RosmMarker } from "../map/RosmMap";

// Human-facing confirmation shown after a save. No raw OSM tags reach the UI.
const SAVED_LABEL: Record<SurveyAction, string> = {
  confirm: "Working",
  broken: "Broken",
  out_of_order: "Out of order",
  removed: "Removed",
};

// Same ceiling as an outbox send: a create that hangs on a dead cell must give
// the add sheet its error back rather than spin.
const CREATE_TIMEOUT_MS = 30_000;

type CreatedNode = {
  nodeId: number;
  changesetId: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
};

// The Expo run session: live GPS, the shared guidance derived from it, the OSM
// recording actions, and marker DATA for RosmMap. Mirrors the web useRunSession
// but returns markers as plain data (the screen owns the bottom sheet). Ending
// the run is run/runLifecycle's endRun, not part of the session.
export function useRunSession({ enabled = true }: { enabled?: boolean } = {}) {
  const run = useRun();
  const { status: osm } = useOsmStatus();
  const [pos, setPos] = useState<Pt | null>(null);
  const [manualArrived, setManualArrived] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(() => enabled && !useRun.getState().hasPlan);
  const [nothingToResume, setNothingToResume] = useState(false);
  const [lastSaved, setLastSaved] = useState<{ nodeId: number; label: string } | null>(null);

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
    const watch = trackRun(
      (p) => setPos({ lat: p.lat, lon: p.lon }),
      (msg) => setErr(msg),
    );
    return () => watch.clear();
  }, [enabled, hasPlan, routeId]);

  // Keep the screen awake + ask for notification permission while armed.
  useEffect(() => {
    if (!enabled) return;
    keepAwake();
    ensureNotifyPermission();
    return () => allowSleep();
  }, [enabled]);

  const { stops, index, tagKey, tagValue, added, pool, routeCoords, turns } = run;
  const addLabel = ptLabel(tagKey, tagValue);
  const target: RunStop | undefined = stops[index];
  const done = hasPlan && index >= stops.length;

  // The stretch of route between the previous stop and this one, so the
  // guidance doesn't latch onto another pass of a route that doubles back.
  // Changes only with the stop, not with each fix.
  const stretch = useMemo(
    () => guidanceWindow(routeCoords, stops, index),
    [routeCoords, stops, index],
  );
  const { distToTarget, bearingTo, nextTurn, distToTurn, autoArrived } = runGuidance(
    pos,
    target ?? null,
    routeCoords,
    turns,
    stretch,
  );
  const heading = target ? compass(bearingTo) : "";
  const arrived = manualArrived || autoArrived;

  // Proximity alert, once per target within the proximity band.
  const notifiedProxRef = useRef<number>(-1);
  useEffect(() => {
    if (!enabled || !target || distToTarget == null) return;
    if (
      distToTarget < PROXIMITY_RADIUS_M &&
      distToTarget >= ARRIVAL_RADIUS_M &&
      notifiedProxRef.current !== index
    ) {
      notifiedProxRef.current = index;
      notifyProximity(target.tags?.name || `node ${target.id}`, distToTarget);
    }
  }, [enabled, target, distToTarget, index]);

  // The lock-screen progress line. Handed every fix; the notifier decides
  // whether it's worth a post. Taken down once every stop is done, and when the
  // run leaves the screen.
  useEffect(() => {
    if (!enabled) return;
    if (!target) {
      endRunProgress();
      return;
    }
    if (distToTarget == null) return;
    showRunProgress(
      progressLine({
        stopKey: `${index}:${target.id}`,
        stopName: target.tags?.name || `Stop #${index + 1}`,
        distToStopM: distToTarget,
        nextTurn,
        distToTurnM: distToTurn,
      }),
    );
  }, [enabled, target, distToTarget, index, nextTurn, distToTurn]);
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
    }
    if (!done) notifiedDoneRef.current = false;
  }, [enabled, done, stops]);

  const advance = useCallback(() => {
    const ni = index + 1;
    run.setIndex(ni);
    setManualArrived(false);
    archiveRun(ni);
  }, [index, run]);

  const recordFor = useCallback(
    (node: Fountain, action: SurveyAction, extras?: EditExtras) => {
      const isCurrent = !!target && node.id === target.id;
      setErr(null);
      useOutbox
        .getState()
        .enqueue({ nodeId: node.id, action, tagKey, name: node.tags?.name, extras });
      run.setStatus(node.id, action as RunStop["status"]);
      celebratePoint();
      hapticSuccess();
      setLastSaved({ nodeId: node.id, label: SAVED_LABEL[action] });
      // advance() archives the run at the next stop; a node off the current
      // stop is archived where the run stands.
      if (isCurrent) advance();
      else archiveRun(index);
      useOutbox.getState().flush();
    },
    [target, tagKey, run, index, advance],
  );

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
  // status to pending so the arrival actions show again (a re-record just
  // enqueues a fresh OSM edit — last write wins). No-op at the first stop.
  const goBack = useCallback(() => {
    if (index <= 0) return;
    const pi = index - 1;
    setLastSaved(null);
    setManualArrived(false);
    run.setStatus(stops[pi].id, "pending");
    run.setIndex(pi);
    archiveRun(pi);
  }, [index, stops, run]);

  // Create a brand-new node of the surveyed type at a given spot (GPS position
  // or tapped map location). Rejects with a message fit for the user, so the
  // add sheet can keep what was entered for another try. Sent straight away,
  // not queued like an edit: a create resent after a reply that was lost would
  // add the point twice.
  const addAt = useCallback(
    async (at: { lat: number; lon: number }, extras?: EditExtras): Promise<void> => {
      // The token is the sign-in: the status endpoint can't tell signed out
      // from offline.
      if (!getToken()) throw new Error("Sign in to OSM first.");
      setErr(null);
      setLastSaved(null);
      const reply = await callApi<CreatedNode>(
        "/api/osm/create",
        postJson({
          lat: at.lat,
          lon: at.lon,
          tag: { key: tagKey, value: tagValue },
          changesetId: useOutbox.getState().changesetId,
          extras,
          surveyDate: todayLocal(),
        }),
        CREATE_TIMEOUT_MS,
        "Couldn't add the point. Please try again.",
      );
      if (!reply.ok) throw new Error(reply.message);
      const j = reply.data;
      if (typeof j?.nodeId !== "number") throw new Error(UNEXPECTED_REPLY);
      useOutbox.getState().setChangeset(j.changesetId);
      run.setChangeset(j.changesetId);
      run.addNode({ id: j.nodeId, lat: j.lat, lon: j.lon, tags: j.tags });
      celebratePoint();
      hapticSuccess();
      setLastSaved({ nodeId: j.nodeId, label: "Added" });
      archiveRun(index);
    },
    [tagKey, tagValue, run, index],
  );

  const addHere = useCallback(async () => {
    if (!pos) {
      setErr("Waiting for GPS fix.");
      return;
    }
    await addAt(pos).catch((e: Error) => setErr(e.message));
  }, [pos, addAt]);

  // The panel's error line, for a failure whose own UI has gone: an add whose
  // sheet was swiped away while it saved.
  const reportError = useCallback((message: string) => setErr(message), []);

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

  const markers: RosmMarker[] = useMemo(() => {
    const onRoute = new Set(stops.map((s) => s.id));
    const stopMarkers: RosmMarker[] = stops.map((s, i) => ({
      id: s.id,
      lat: s.lat,
      lon: s.lon,
      color: i === index && s.status === "pending" ? "#2563eb" : STATUS_COLOR[s.status],
      label: String(i + 1),
    }));
    const addedMarkers: RosmMarker[] = added.map((f) => ({
      id: f.id,
      lat: f.lat,
      lon: f.lon,
      color: "#16a34a",
      label: "+",
    }));
    const dimMarkers: RosmMarker[] = pool
      .filter((f) => !onRoute.has(f.id))
      .map((f) => ({ id: f.id, lat: f.lat, lon: f.lon, color: "#9ca3af", dimmed: true }));
    return [...dimMarkers, ...stopMarkers, ...addedMarkers];
  }, [stops, index, added, pool]);

  const center: [number, number] = pos
    ? [pos.lat, pos.lon]
    : target
      ? [target.lat, target.lon]
      : [run.start.lat, run.start.lon];

  const fitPoints: [number, number][] | undefined =
    pos && target
      ? [
          [pos.lat, pos.lon],
          [target.lat, target.lon],
        ]
      : undefined;

  const recenterKey =
    (pos ? `${pos.lat.toFixed(4)},${pos.lon.toFixed(4)}` : "t") +
    (target ? `|${target.lat.toFixed(4)},${target.lon.toFixed(4)}` : "");

  return {
    markers,
    line,
    center,
    userPos: pos ? ([pos.lat, pos.lon] as [number, number]) : null,
    recenterKey,
    fitPoints,
    hydrating,
    nothingToResume,
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
    setManualArrived,
    recordFor,
    record,
    skip,
    goBack,
    endEarly,
    addHere,
    addAt,
    reportError,
  };
}

export type RunSession = ReturnType<typeof useRunSession>;
