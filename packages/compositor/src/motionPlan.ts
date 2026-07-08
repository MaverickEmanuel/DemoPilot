// ----------------------------------------------------------------------------
// Motion plan — the shared source of truth for the visible cursor AND the camera.
//
// The recorder captures a *real* Playwright pointer (so hover/focus states fire),
// but its between-action travels are uncoordinated with the render-time camera:
// the recorded cursor is fixed at capture, the camera is simulated at render, and
// nothing relates their timing, direction, or velocity. That mismatch produced
// the whip/drift/wobble artifacts this module removes.
//
// Instead, one pure `buildMotionPlan(timeline, fps)` derives, from the recorded
// timeline, a set of *beats*:
//
//   • travels — synthesized min-jerk arcs between consecutive actions. `tArrive`
//     is pinned to the recorded landing sample and `from`/`to` to the recorded
//     endpoints, so the composed path stays continuous and click points stay
//     pixel-exact. Duration targets a constant *apparent* screen speed (measured
//     after the follow-cam is subtracted), so a cross-screen move never whips.
//   • holds — the parked windows between an action and its next travel (the
//     cursor is verifiably stationary there).
//   • navs — establish-hold windows: on a navigation the camera eases to a calm,
//     centered establish framing and holds until the next travel departs, so it
//     never glides over a blank page.
//   • shots — per-group camera windows (anchor + adaptive depth). Shot windows
//     are derived from the travels so the camera *follows* the cursor (it
//     retargets `FOLLOW_LAG_MS` after the cursor departs and glides the same
//     direction), never anticipating against it.
//
// The camera spring (camera.ts) consumes `plan.shots`/`plan.navs`; the cursor
// sampler (`plannedCursorAt` in interp.ts) consumes `plan.travels`/`plan.holds`.
// Everything here is a pure function of (timeline, fps) — deterministic by
// construction (no randomness, no spring sampling).
// ----------------------------------------------------------------------------

import type { Timeline, CursorSample } from "./types";
import { buildActionGroups, type ActionItem, type Vec } from "./groups";
import { computeCameraTrack, resolve, depthFor, anchorFor, type CameraTrack } from "./camera";
import { cardLayout, CANVAS } from "./frame";
import { contentStartMs } from "./interp";
import { outputDurationMs } from "./outro";

// Re-exported so the tuning constants and the duration helper have one import
// site (motionPlan) for the browser-bundle consumers, while the Node render/audio
// path imports them straight from the dependency-free ./outro leaf module.
export { OUTRO_HOLD_MS, OUTRO_FADE_MS, outputDurationMs } from "./outro";

// --- Tuning constants (single place, exported for tests) --------------------

/** Target cursor speed in canvas px/s, measured after the follow-cam is subtracted. */
export const APPARENT_SPEED_PX_S = 850;
/** Clamp on a synthesized travel's ideal duration (before the gap cap). */
export const TRAVEL_MIN_MS = 420;
export const TRAVEL_MAX_MS = 1600;
/** Min gap kept between the previous action's end and a travel's departure. */
export const TRAVEL_GAP_MARGIN_MS = 60;
/** Camera retarget delay after cursor departure (the "follow" in follow-cam). */
export const FOLLOW_LAG_MS = 120;
/** Perpendicular arc bow: fraction of travel length, capped (video px). */
export const ARC_BOW_FRAC = 0.025;
export const ARC_BOW_MAX_PX = 28;
/** Stillness before the cursor fades out. */
export const IDLE_FADE_AFTER_MS = 2000;
/** Idle fade-out length / how long before departure the fade-in completes. */
export const IDLE_FADE_MS = 260;
export const PRE_TRAVEL_FADEIN_MS = 150;
// Freeze-hold past the recording / final fade live in ./outro (shared with the
// Node render/audio path) and are re-exported above.

// Shot-window lead/tail (used only when a shot has no entering/exiting travel:
// the first shot, or the first action after a `goto`). Between-travel shots
// abut at the travel departure instead (follow-cam by construction).
const LEAD_MS = 440;
const TAIL_MS = 580;
// A move under this (video px) is not worth synthesizing; recorded samples cover it.
const MIN_TRAVEL_DIST_PX = 4;
// A recorded sample within this of the target is the travel's landing sample.
const ARRIVAL_TOL_PX = 2;
// Shortest synthesized travel we will emit when the gap is tight; below this we
// fall back to the recorded samples for that segment.
const MIN_TRAVEL_DURATION_MS = 120;
// tArrive fallback for older timelines with no landing sample near the target.
const ARRIVAL_FALLBACK_MS = 200;

// --- Beat + plan types ------------------------------------------------------

export interface TravelBeat {
  kind: "travel";
  /** ms (timeline time) — visible cursor leaves `from`. */
  tDepart: number;
  /** ms — lands on `to`; equals the RECORDED arrival time. */
  tArrive: number;
  /** video-space position (== recorded position at tDepart). */
  from: Vec;
  /** video-space position (== next action's point). */
  to: Vec;
  /** perpendicular arc offset vector at the path midpoint. */
  bow: Vec;
  /** index of the shot this travel enters (null if same shot). */
  toShot: number | null;
}
export interface HoldBeat {
  kind: "hold";
  t0: number;
  t1: number;
  at: Vec;
}
export interface NavBeat {
  kind: "nav";
  t0: number;
  t1: number;
}
/** A group resolved into its camera shot: anchor, adaptive depth, focus window. */
export interface PlannedShot {
  anchor: Vec;
  level: number;
  focusStart: number;
  focusEnd: number;
}
export interface IdleFade {
  fadeOutAt: number;
  /** When the fade-in completes (Infinity for the final hold — never fades back). */
  fadeInAt: number;
}
export interface MotionPlan {
  /** sorted by tDepart, non-overlapping. */
  travels: TravelBeat[];
  /** the parked windows between/after actions. */
  holds: HoldBeat[];
  /** one per navigate that separates two shots (camera establish-hold). */
  navs: NavBeat[];
  /** camera shot windows. */
  shots: PlannedShot[];
  contentStartMs: number;
  /** precomputed from holds. */
  idleFades: IdleFade[];
  /** recording length (ms). */
  durationMs: number;
  /** recording length + the outro freeze-hold. */
  outputDurationMs: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** First recorded sample in (tLo, tHi] within ARRIVAL_TOL_PX of `target` — the
 * final sample of the recorded move (moveCursor lands exactly on the target). */
function arrivalTime(samples: CursorSample[], tLo: number, tHi: number, target: Vec): number | null {
  for (const s of samples) {
    if (s.t <= tLo) continue;
    if (s.t > tHi) break;
    if (Math.hypot(s.x - target.x, s.y - target.y) <= ARRIVAL_TOL_PX) return s.t;
  }
  return null;
}

/** The earliest nav time strictly within (a, b), or null. */
function firstNavIn(navTimes: number[], a: number, b: number): number | null {
  for (const t of navTimes) if (t > a && t < b) return t;
  return null;
}
function lastNavIn(navTimes: number[], a: number, b: number): number | null {
  let v: number | null = null;
  for (const t of navTimes) if (t > a && t <= b) v = t;
  return v;
}
function lastNavBefore(navTimes: number[], t: number): number | null {
  let v: number | null = null;
  for (const n of navTimes) if (n <= t) v = n;
  return v;
}

/** Perpendicular arc bow, signed so the arc bows toward the viewport center.
 * Purely geometric ⇒ deterministic. */
function bowVector(from: Vec, to: Vec, cx: number, cy: number): Vec {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: 0 };
  // perp = (-dy, dx) is the +90° rotation; dot(perp, center-from) == the cross
  // product of (to-from) with (center-from), so its sign points toward center.
  const cross = dx * (cy - from.y) - dy * (cx - from.x);
  const sign = cross >= 0 ? 1 : -1;
  const mag = Math.min(ARC_BOW_FRAC * len, ARC_BOW_MAX_PX) * sign;
  return { x: (-dy / len) * mag, y: (dx / len) * mag };
}

/**
 * Derives the full motion plan from a recorded timeline. Pure and deterministic.
 */
export function buildMotionPlan(timeline: Timeline, fps: number): MotionPlan {
  void fps; // plan geometry is fps-independent; kept for API symmetry / future use.
  const cfg = resolve(timeline.zoom);
  const vw = timeline.width;
  const vh = timeline.height;
  const cx = vw / 2;
  const cy = vh / 2;
  const durationMs = timeline.durationMs;
  const outDurationMs = outputDurationMs(durationMs);

  const groups = buildActionGroups(timeline, cfg.groupGapMs);
  const samples = timeline.cursor;
  const navTimes = timeline.events
    .filter((e) => e.kind === "navigate")
    .map((e) => e.t)
    .sort((a, b) => a - b);

  // The plan targets the framed 1080p canvas (the default). The card layout scale
  // is a pure function of the video dims, so travel speed is measured in canvas px.
  const layoutScale = cardLayout(CANVAS.width, CANVAS.height, vw, vh).scale;

  // 1. Shot geometry (anchor + adaptive depth) per group. Windows filled in step 4.
  const shots: PlannedShot[] = groups.map((g) => ({
    anchor: anchorFor(g.bbox),
    level: depthFor(g.bbox, vw, vh, cfg),
    focusStart: 0,
    focusEnd: 0,
  }));

  // Flat, time-ordered action list tagged with its shot (group) index. Groups
  // partition the actions contiguously in time, so this preserves action order.
  const flat: Array<{ item: ActionItem; shotIdx: number }> = [];
  groups.forEach((g, gi) => g.items.forEach((item) => flat.push({ item, shotIdx: gi })));

  // 2. Between-action travels. `enterTravelOf[k]` is the boundary travel entering
  // shot k (its `to` is shot k's first action); `outgoingTravel[i]` is the travel
  // departing from flat action i (drives the parked hold before it).
  const travels: TravelBeat[] = [];
  const enterTravelOf: number[] = new Array(shots.length).fill(-1);
  const outgoingTravel: Array<TravelBeat | undefined> = new Array(flat.length).fill(undefined);
  const incomingTravel: Array<TravelBeat | undefined> = new Array(flat.length).fill(undefined);

  for (let i = 1; i < flat.length; i++) {
    const prev = flat[i - 1].item;
    const next = flat[i].item;
    const from = prev.point;
    const to = next.point;
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < MIN_TRAVEL_DIST_PX) continue;

    const dstShotIdx = flat[i].shotIdx;
    const crossesGroup = dstShotIdx !== flat[i - 1].shotIdx;

    const tArrive = arrivalTime(samples, prev.end, next.start, to) ?? next.start - ARRIVAL_FALLBACK_MS;

    // Apparent screen distance: project through the destination shot's transform
    // (translate cancels in a difference) × the card layout scale.
    const shotScale = shots[dstShotIdx].level;
    const screenDist = dist * shotScale * layoutScale;

    let duration = clamp((screenDist / APPARENT_SPEED_PX_S) * 1000, TRAVEL_MIN_MS, TRAVEL_MAX_MS);
    const maxByGap = tArrive - prev.end - TRAVEL_GAP_MARGIN_MS;
    if (maxByGap < duration) duration = maxByGap;
    if (duration < MIN_TRAVEL_DURATION_MS) continue; // no room → recorded fallback

    let tDepart = tArrive - duration;
    // Never depart before the page the cursor is on exists (don't glide over a
    // nav blank): floor to the last nav strictly between prev.end and tArrive.
    const nav = lastNavIn(navTimes, prev.end, tArrive);
    if (nav != null && tDepart < nav) {
      tDepart = nav;
      if (tArrive - tDepart < MIN_TRAVEL_DURATION_MS) continue;
    }

    const beat: TravelBeat = {
      kind: "travel",
      tDepart,
      tArrive,
      from,
      to,
      bow: bowVector(from, to, cx, cy),
      toShot: crossesGroup ? dstShotIdx : null,
    };
    travels.push(beat);
    outgoingTravel[i - 1] = beat;
    incomingTravel[i] = beat;
    if (crossesGroup) enterTravelOf[dstShotIdx] = travels.length - 1;
  }

  // 3. Holds fill every parked span so the cursor is pinned on target and never
  // reverts to a stale recorded position:
  //   • an arrival hold from a travel's landing until its action fires (keeps the
  //     cursor on target through the pre-action dwell even on older/degenerate
  //     timelines whose recorded samples never landed on the target); and
  //   • a parked hold from an action's end until its next travel departs (or the
  //     outro freeze-hold for the last action).
  const holds: HoldBeat[] = [];
  for (let i = 0; i < flat.length; i++) {
    const a = flat[i].item;
    const inc = incomingTravel[i];
    if (inc && a.start > inc.tArrive) holds.push({ kind: "hold", t0: inc.tArrive, t1: a.start, at: a.point });
    const out = outgoingTravel[i];
    const t1 = out ? out.tDepart : i === flat.length - 1 ? outDurationMs : null;
    if (t1 == null) continue; // travel skipped and not the last action → recorded fallback
    if (t1 > a.end) holds.push({ kind: "hold", t0: a.end, t1, at: a.point });
  }

  // 4. Shot windows. Between-travel shots abut at (travel.tDepart + FOLLOW_LAG_MS)
  // so the spring supplies the glide and the target always leads toward where the
  // cursor is going (follow-cam). Nav-ended shots stop at the nav.
  for (let k = 0; k < shots.length; k++) {
    const g = groups[k];
    const enter = enterTravelOf[k];
    if (enter >= 0) {
      shots[k].focusStart = travels[enter].tDepart + FOLLOW_LAG_MS;
    } else {
      let fs = g.tStart - LEAD_MS;
      const navB = lastNavBefore(navTimes, g.tStart);
      if (navB != null) fs = Math.max(fs, navB);
      shots[k].focusStart = fs;
    }

    if (k === shots.length - 1) {
      shots[k].focusEnd = Math.max(g.tEnd + TAIL_MS, shots[k].focusStart);
    } else {
      const next = groups[k + 1];
      const nav = firstNavIn(navTimes, g.tEnd, next.tStart);
      const exit = enterTravelOf[k + 1];
      let fe: number;
      if (nav != null) fe = nav;
      else if (exit >= 0) fe = travels[exit].tDepart + FOLLOW_LAG_MS;
      else fe = (g.tEnd + next.tStart) / 2;
      shots[k].focusEnd = Math.max(fe, shots[k].focusStart);
    }
  }

  // 4b. Bridge same-page shot boundaries that have no boundary travel (the two
  // group-crossing actions are within MIN_TRAVEL_DIST_PX, so no travel was
  // synthesized) and no navigation. Without a travel to time the handoff — and
  // with the group split forcing focusStart to `tStart − LEAD_MS` — an uncovered
  // window would open between the shots and `targetAt` would fall to the wide
  // default (a full zoom-out lurch). Abut the windows so the spring holds/pans
  // directly instead. (Nav boundaries are already bridged by their nav beat.)
  for (let k = 1; k < shots.length; k++) {
    if (enterTravelOf[k] >= 0) continue;
    if (firstNavIn(navTimes, groups[k - 1].tEnd, groups[k].tStart) != null) continue;
    shots[k].focusStart = Math.min(shots[k].focusStart, shots[k - 1].focusEnd);
  }

  // 5. Navs: one establish-hold per navigation that separates two shots.
  const navs: NavBeat[] = [];
  for (let k = 0; k < shots.length - 1; k++) {
    const nav = firstNavIn(navTimes, groups[k].tEnd, groups[k + 1].tStart);
    if (nav == null) continue;
    const exit = enterTravelOf[k + 1];
    const t1 = exit >= 0 ? travels[exit].tDepart + FOLLOW_LAG_MS : shots[k + 1].focusStart;
    navs.push({ kind: "nav", t0: nav, t1: Math.max(t1, nav) });
  }

  // 6. Idle fades: any hold longer than IDLE_FADE_AFTER_MS. The hold's t1 is the
  // next travel's departure (or the outro), so the fade completes just before it.
  const idleFades: IdleFade[] = [];
  for (const h of holds) {
    if (h.t1 - h.t0 <= IDLE_FADE_AFTER_MS) continue;
    const fadeOutAt = h.t0 + IDLE_FADE_AFTER_MS;
    const fadeInAt = Number.isFinite(h.t1) && h.t1 < outDurationMs ? h.t1 - PRE_TRAVEL_FADEIN_MS : Infinity;
    if (fadeInAt <= fadeOutAt) continue; // hold too short to both fade out and back in
    idleFades.push({ fadeOutAt, fadeInAt });
  }

  return {
    travels,
    holds,
    navs,
    shots,
    contentStartMs: contentStartMs(timeline),
    idleFades,
    durationMs,
    outputDurationMs: outDurationMs,
  };
}

/** Builds the motion plan and the camera spring track together, so callers
 * compute the plan exactly once and share it between the cursor and the camera. */
export function computeCameraMotion(
  timeline: Timeline,
  fps: number,
): { track: CameraTrack; plan: MotionPlan } {
  const plan = buildMotionPlan(timeline, fps);
  const track = computeCameraTrack(timeline, fps, plan);
  return { track, plan };
}
