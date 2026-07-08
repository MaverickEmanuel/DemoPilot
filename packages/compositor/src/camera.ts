// ----------------------------------------------------------------------------
// Spring-physics tracking camera (fit-to-rect, edge-clamped) — plan-driven.
//
// The camera frames one action group at a time. Each group ("shot") gets a
// single focus center (the center of its members' union box) and an adaptive
// depth: the target scale fits the bbox into an inner *safe area* (the viewport
// inset by a constant margin), so small targets zoom deeper and large regions
// shallower. A critically-ish-damped spring chases a time-varying *target*
// {scale, focus}, producing the motion.
//
// The shot *windows* and the navigation establish-holds come from the shared
// motion plan (motionPlan.ts), which derives them from the synthesized cursor
// travels. That makes the camera a FOLLOW-cam: it retargets a beat *after* the
// cursor departs (never anticipating against it) and, between same-page shots,
// the windows abut so the spring glides directly toward where the cursor is
// going. On a navigation the target eases to a calm, centered establish framing
// and holds there until the next travel departs — so the camera never glides
// over a blank page. There is no establishing "dome" pull-back and no
// pan-vs-zoom classification; every same-page transition is a direct pan.
//
// The spring chases the RAW bbox center (no corner clamping). Framing is handled
// at apply time by `cameraTransform`, which converts (focus, scale) into a
// translate+scale and clamps the translation so the scaled content always fully
// covers the viewport — no background bleed, and edge/corner elements are framed
// as far into the corner as geometry allows instead of being clipped.
//
// The whole spring is simulated once into a uniform keyframe track (extended by
// the outro freeze-hold); `cameraAt` samples it per frame.
// ----------------------------------------------------------------------------

import type { Timeline, ZoomConfig, Box } from "./types";
import type { ActionGroup, Vec } from "./groups";
import type { MotionPlan } from "./motionPlan";

export interface CameraState {
  scale: number;
  /** Focus center (raw bbox center) the camera frames, in video pixels. */
  focusX: number;
  focusY: number;
}

/** The applied transform: translate then uniform scale, transform-origin 0 0. */
export interface CameraTransform {
  tx: number;
  ty: number;
  scale: number;
}

export interface CameraTrack {
  fps: number;
  /** Uniformly spaced (1/fps) keyframes from t=0 to the output duration. */
  frames: CameraState[];
  cursorScale: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

// Box padding before computing depth, for a little breathing room.
const BOX_PAD = 1.1;

// Outro: after the final action the camera eases all the way back out to the
// full, unzoomed frame — a deliberate "and we're done" reset that releases the
// viewer from the zoomed working shot and reveals the whole result in context.
const OUTRO_REST = 1.0;

export interface Resolved {
  minZoom: number;
  maxZoom: number;
  /** Inner safe-area insets (fraction of viewport) the focus rect is fit into. */
  innerSafeX: number;
  innerSafeY: number;
  establishLevel: number;
  /** @deprecated Read no more — every same-page transition is a direct pan. */
  panThreshold: number;
  stiffness: number;
  damping: number;
  groupGapMs: number;
  cursorScale: number;
}

export function resolve(z: ZoomConfig | undefined): Resolved {
  const level = z?.level ?? 1.25;
  return {
    minZoom: z?.minZoom ?? 1.0,
    // Capped lower than before: deep zoom into small targets (a corner button, a
    // modal field) crops surrounding context and softens the already-upscaled
    // capture. 1.55 keeps a clear "punch" while showing more around the target.
    maxZoom: z?.maxZoom ?? Math.max(1.0, level > 1.25 ? level : 1.55),
    innerSafeX: z?.innerSafeX ?? 0.1,
    innerSafeY: z?.innerSafeY ?? 0.1,
    establishLevel: z?.establishLevel ?? 1.06,
    panThreshold: z?.panThreshold ?? 0.42,
    stiffness: z?.stiffness ?? 8,
    damping: z?.damping ?? 0.92,
    groupGapMs: z?.groupGapMs ?? 1800,
    cursorScale: z?.cursorScale ?? 1.5,
  };
}

// Adaptive depth: scale that fits the (padded) bbox into the inner safe area.
// min(safeW/bw, safeH/bh) frames the rect with constant breathing room on every
// side; clamping to [minZoom, maxZoom] caps how deep a tiny target may punch.
export function depthFor(bbox: Box, vw: number, vh: number, cfg: Resolved): number {
  const bw = Math.max(1, bbox.width * BOX_PAD);
  const bh = Math.max(1, bbox.height * BOX_PAD);
  const safeW = vw * (1 - 2 * cfg.innerSafeX);
  const safeH = vh * (1 - 2 * cfg.innerSafeY);
  const s = Math.min(safeW / bw, safeH / bh);
  return clamp(s, cfg.minZoom, cfg.maxZoom);
}

// The raw bbox center. Framing/clamping is deferred to `cameraTransform`, so the
// spring is free to chase the true center (even near an edge) without the corner
// clamping that used to fling edge elements off-screen.
export function anchorFor(bbox: Box): Vec {
  return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
}

/**
 * Pure: converts a sampled camera state into the transform applied to the
 * moving content (and cursor). With transform-origin "0 0":
 *
 *   tx = vw/2 - focusX*s;  ty = vh/2 - focusY*s
 *
 * centers the focus point in the viewport. The coverage clamp then keeps
 * [tx, tx + vw*s] ⊇ [0, vw] (and likewise y), guaranteeing the scaled content
 * always fully covers the card. For a corner focus the clamp pins translation to
 * its limit, framing the element as far into the corner as possible while it
 * stays fully on-screen. scale ≥ 1 (enforced upstream) keeps the clamp valid.
 */
export function cameraTransform(cam: CameraState, vw: number, vh: number): CameraTransform {
  const s = cam.scale;
  let tx = vw / 2 - cam.focusX * s;
  let ty = vh / 2 - cam.focusY * s;
  tx = clamp(tx, -vw * (s - 1), 0);
  ty = clamp(ty, -vh * (s - 1), 0);
  return { tx, ty, scale: s };
}

/** Public: the adaptive depth chosen for a group (exposed for tests). */
export function groupDepth(group: ActionGroup, timeline: Timeline): number {
  return depthFor(group.bbox, timeline.width, timeline.height, resolve(timeline.zoom));
}

/** The camera's target {scale, x, y} at time t, from the plan's shots and navs.
 *
 *   1. inside a nav establish-hold → calm centered establish framing;
 *   2. inside a shot window        → that shot's anchor/depth (follow-cam glide);
 *   3. after the last shot         → full zoom-out (centered outro reset);
 *   4. before the first shot       → wide (the intro reveal zooms in).
 */
function targetAt(t: number, plan: MotionPlan, cfg: Resolved, cx: number, cy: number): CameraState {
  for (const nv of plan.navs) {
    if (t >= nv.t0 && t < nv.t1) {
      return { scale: Math.max(cfg.establishLevel, 1), focusX: cx, focusY: cy };
    }
  }
  for (const s of plan.shots) {
    if (t >= s.focusStart && t <= s.focusEnd) {
      return { scale: s.level, focusX: s.anchor.x, focusY: s.anchor.y };
    }
  }
  const shots = plan.shots;
  if (shots.length && t >= shots[shots.length - 1].focusEnd) {
    return { scale: OUTRO_REST, focusX: cx, focusY: cy };
  }
  return { scale: 1, focusX: cx, focusY: cy };
}

/** Simulates the spring once and returns a uniform per-frame keyframe track.
 * The track spans the output duration (recording + outro freeze-hold), so the
 * camera rests at the landing framing while the final frame holds. */
export function computeCameraTrack(timeline: Timeline, fps: number, plan: MotionPlan): CameraTrack {
  const cfg = resolve(timeline.zoom);
  const cx = timeline.width / 2;
  const cy = timeline.height / 2;

  const frameMs = 1000 / fps;
  const nFrames = Math.max(1, Math.ceil(plan.outputDurationMs / frameMs) + 1);

  // Spring state. Sub-step the integration for stability independent of fps.
  let s = 1;
  let x = cx;
  let y = cy;
  let vs = 0;
  let vx = 0;
  let vy = 0;
  const subDt = 1 / 240; // seconds
  const omega = cfg.stiffness;
  const zeta = cfg.damping;
  const step = (val: number, vel: number, target: number, dt: number): [number, number] => {
    const a = omega * omega * (target - val) - 2 * zeta * omega * vel;
    const nv = vel + a * dt;
    return [val + nv * dt, nv];
  };

  const frames: CameraState[] = [];
  let simT = 0; // seconds
  for (let f = 0; f < nFrames; f++) {
    const frameT = (f * frameMs) / 1000; // seconds
    // Integrate up to this frame in fixed sub-steps.
    while (simT < frameT - 1e-9) {
      const dt = Math.min(subDt, frameT - simT);
      const tgt = targetAt(simT * 1000, plan, cfg, cx, cy);
      [s, vs] = step(s, vs, tgt.scale, dt);
      [x, vx] = step(x, vx, tgt.focusX, dt);
      [y, vy] = step(y, vy, tgt.focusY, dt);
      simT += dt;
    }
    frames.push({ scale: Math.max(1, s), focusX: x, focusY: y });
  }

  return { fps, frames, cursorScale: cfg.cursorScale };
}

/** Samples the precomputed camera track at time `tMs` (linear between frames). */
export function cameraAt(track: CameraTrack, tMs: number): CameraState {
  const { frames, fps } = track;
  if (frames.length === 0) return { scale: 1, focusX: 0, focusY: 0 };
  const idx = (tMs / 1000) * fps;
  if (idx <= 0) return frames[0];
  if (idx >= frames.length - 1) return frames[frames.length - 1];
  const i = Math.floor(idx);
  const u = idx - i;
  const a = frames[i];
  const b = frames[i + 1];
  return {
    scale: lerp(a.scale, b.scale, u),
    focusX: lerp(a.focusX, b.focusX, u),
    focusY: lerp(a.focusY, b.focusY, u),
  };
}

/**
 * The camera's screen-space speed at time `tMs`, in card-space px per frame —
 * the magnitude of the applied-transform change over one frame. Combines the
 * translation delta with the scale delta (weighted by viewport width, since a
 * scale change moves content proportionally to its extent). Drives synthetic
 * motion blur: fast pans/zooms smear, holds stay crisp.
 */
export function cameraSpeedAt(track: CameraTrack, tMs: number, vw: number, vh: number): number {
  const frameMs = 1000 / track.fps;
  const cur = cameraTransform(cameraAt(track, tMs), vw, vh);
  const prev = cameraTransform(cameraAt(track, Math.max(0, tMs - frameMs)), vw, vh);
  const dTrans = Math.hypot(cur.tx - prev.tx, cur.ty - prev.ty);
  const dScale = Math.abs(cur.scale - prev.scale) * vw;
  return dTrans + dScale;
}

/** Resolves just the cursor magnification (used when the camera is disabled). */
export function cursorScaleOf(timeline: Timeline): number {
  return resolve(timeline.zoom).cursorScale;
}
