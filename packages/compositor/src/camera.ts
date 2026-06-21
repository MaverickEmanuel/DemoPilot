// ----------------------------------------------------------------------------
// Spring-physics tracking camera (fit-to-rect, edge-clamped)
//
// The camera frames one action group at a time. Each group gets a single focus
// center (the center of its members' union box) and an adaptive depth: the
// target scale fits the bbox into an inner *safe area* (the viewport inset by a
// constant margin), so small targets zoom deeper and large regions shallower. A
// critically-ish-damped spring chases a time-varying *target* {scale, focus},
// which produces the motion:
//
//   • within a group        → hold: target = that group's focus + depth
//   • between near groups    → PAN: target morphs focus/depth toward the next
//                              group while staying zoomed (spring glides over)
//   • between far groups      → HYBRID: a brief establishing beat eases the depth
//                              out to `establishLevel`, glides, then eases back in
//   • before/after the demo  → wide (scale 1)
//
// The spring chases the RAW bbox center (no corner clamping). Framing is handled
// at apply time by `cameraTransform`, which converts (focus, scale) into a
// translate+scale and clamps the translation so the scaled content always fully
// covers the viewport — no background bleed, and edge/corner elements are framed
// as far into the corner as geometry allows instead of being clipped.
//
// Navigations always cut a group, so the camera never drags a zoom across a page
// transition. The whole spring is simulated once into a uniform keyframe track;
// `cameraAt` samples it per frame.
// ----------------------------------------------------------------------------

import type { Timeline, ZoomConfig, Box } from "./types";
import { buildActionGroups, type ActionGroup, type Vec } from "./groups";

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
  /** Uniformly spaced (1/fps) keyframes from t=0 to durationMs. */
  frames: CameraState[];
  cursorScale: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

// Lead-in before a group's first action and tail after its last (cinematic hold).
// Lead is generous so the camera *anticipates* arrival (settles on the next target
// a beat before it acts); tail is kept tight so the demo stays responsive and the
// camera moves on to the next beat without dwelling on a finished action.
const LEAD_MS = 440;
const TAIL_MS = 580;
// Minimum establishing gap carved out for a far handoff.
const GAP_MIN_MS = 220;
// Box padding before computing depth, for a little breathing room.
const BOX_PAD = 1.1;

// Far-handoff establishing pull-back. Rather than zooming (nearly) all the way
// out between far-apart shots — which reads as an awkward "reset" — the camera
// stays in the app context and pulls back only modestly while it glides to the
// next target. The establishing depth is the shallower of the two shots reduced
// by ESTABLISH_DROP, floored by the config's `establishLevel`.
const ESTABLISH_DROP = 0.28;
// Outro: after the final action the camera eases to a gentle "landing" framing
// (a slight pull-back that reveals the result in context) instead of a full
// zoom-out to a wide, empty shot — which read as a soft, slow reset.
const OUTRO_REST = 1.12;

interface Resolved {
  minZoom: number;
  maxZoom: number;
  /** Inner safe-area insets (fraction of viewport) the focus rect is fit into. */
  innerSafeX: number;
  innerSafeY: number;
  establishLevel: number;
  panThreshold: number;
  stiffness: number;
  damping: number;
  groupGapMs: number;
  cursorScale: number;
}

function resolve(z: ZoomConfig | undefined): Resolved {
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
function depthFor(bbox: Box, vw: number, vh: number, cfg: Resolved): number {
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
function anchorFor(bbox: Box): Vec {
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

/** A group resolved into its camera shot: focus window, anchor and depth. */
interface Shot {
  focusStart: number;
  focusEnd: number;
  anchor: Vec;
  level: number;
}

/** Classified transition between two consecutive shots. */
interface Gap {
  start: number;
  end: number;
  far: boolean;
  from: Shot;
  to: Shot;
}

/** Public: the adaptive depth chosen for a group (exposed for tests). */
export function groupDepth(group: ActionGroup, timeline: Timeline): number {
  return depthFor(group.bbox, timeline.width, timeline.height, resolve(timeline.zoom));
}

function buildShots(timeline: Timeline, groups: ActionGroup[], cfg: Resolved): Shot[] {
  const vw = timeline.width;
  const vh = timeline.height;
  const navs = timeline.events.filter((e) => e.kind === "navigate").map((e) => e.t).sort((a, b) => a - b);
  const lastNavBefore = (t: number) => {
    let v = -Infinity;
    for (const n of navs) if (n <= t) v = n;
    return v;
  };
  const firstNavAfter = (t: number) => {
    for (const n of navs) if (n >= t) return n;
    return Infinity;
  };

  const shots: Shot[] = groups.map((g) => {
    let focusStart = g.tStart - LEAD_MS;
    let focusEnd = g.tEnd + TAIL_MS;
    const navB = lastNavBefore(g.tStart);
    if (Number.isFinite(navB)) focusStart = Math.max(focusStart, navB);
    const navA = firstNavAfter(g.tEnd);
    if (Number.isFinite(navA)) focusEnd = Math.min(focusEnd, navA);
    return {
      focusStart,
      focusEnd: Math.max(focusEnd, g.tEnd),
      anchor: anchorFor(g.bbox),
      level: depthFor(g.bbox, vw, vh, cfg),
    };
  });
  return shots;
}

function classifyGaps(timeline: Timeline, groups: ActionGroup[], shots: Shot[], cfg: Resolved): Gap[] {
  const diag = Math.hypot(timeline.width, timeline.height);
  const navBetween = (a: number, b: number) =>
    timeline.events.some((e) => e.kind === "navigate" && e.t > a && e.t < b);
  const gaps: Gap[] = [];
  for (let i = 0; i < shots.length - 1; i++) {
    const a = shots[i];
    const b = shots[i + 1];
    const dist = Math.hypot(b.anchor.x - a.anchor.x, b.anchor.y - a.anchor.y);
    const far = navBetween(groups[i].tEnd, groups[i + 1].tStart) || dist > cfg.panThreshold * diag;
    const mid = (groups[i].tEnd + groups[i + 1].tStart) / 2;
    if (far) {
      // Carve a real establishing gap so the camera can ease out and back in.
      a.focusEnd = Math.min(a.focusEnd, Math.max(groups[i].tEnd, mid - GAP_MIN_MS / 2));
      b.focusStart = Math.max(b.focusStart, mid + GAP_MIN_MS / 2);
    }
    if (a.focusEnd < b.focusStart) {
      gaps.push({ start: a.focusEnd, end: b.focusStart, far, from: a, to: b });
    } else if (!far) {
      // Near and overlapping: meet at the midpoint so it reads as one continuous pan.
      const m = clamp(mid, a.focusStart, b.focusEnd);
      a.focusEnd = m;
      b.focusStart = m;
    }
  }
  return gaps;
}

/** The camera's target {scale, x, y} at time t, given the resolved shots/gaps. */
function targetAt(
  t: number,
  shots: Shot[],
  gaps: Gap[],
  cfg: Resolved,
  cx: number,
  cy: number,
): CameraState {
  for (const s of shots) {
    if (t >= s.focusStart && t <= s.focusEnd) {
      return { scale: s.level, focusX: s.anchor.x, focusY: s.anchor.y };
    }
  }
  for (const g of gaps) {
    if (t > g.start && t < g.end) {
      const u = (t - g.start) / Math.max(1, g.end - g.start);
      const ax = lerp(g.from.anchor.x, g.to.anchor.x, u);
      const ay = lerp(g.from.anchor.y, g.to.anchor.y, u);
      if (g.far) {
        // Gentle establishing pull-back: stay in the app context and ease the
        // depth back only modestly (toward `establish`, not all the way out)
        // while gliding the focus toward the destination. `establish` never goes
        // below `establishLevel` (the floor) nor deeper than the bridging base.
        const dome = Math.sin(Math.PI * u); // 0 → 1 → 0
        const base = lerp(g.from.level, g.to.level, u);
        const establish = Math.max(cfg.establishLevel, Math.min(g.from.level, g.to.level) - ESTABLISH_DROP);
        const scale = lerp(base, Math.min(establish, base), dome);
        return { scale, focusX: ax, focusY: ay };
      }
      // Near: stay zoomed and pan — morph depth and anchor together.
      return { scale: lerp(g.from.level, g.to.level, u), focusX: ax, focusY: ay };
    }
  }
  // Idle. Before the first shot the camera is wide and the intro reveal zooms in.
  // After the last shot it eases to a gentle landing framing (a slight pull-back
  // that shows the result in context) rather than a full zoom-out to wide.
  if (shots.length && t >= shots[shots.length - 1].focusEnd) {
    return { scale: OUTRO_REST, focusX: cx, focusY: cy };
  }
  return { scale: 1, focusX: cx, focusY: cy };
}

/** Simulates the spring once and returns a uniform per-frame keyframe track. */
export function computeCameraTrack(timeline: Timeline, fps: number): CameraTrack {
  const cfg = resolve(timeline.zoom);
  const cx = timeline.width / 2;
  const cy = timeline.height / 2;
  const groups = buildActionGroups(timeline, cfg.groupGapMs);
  const shots = buildShots(timeline, groups, cfg);
  // Single ordered pass: clamps each shot's focus window and emits the gaps.
  const gaps = classifyGaps(timeline, groups, shots, cfg);

  const frameMs = 1000 / fps;
  const nFrames = Math.max(1, Math.ceil(timeline.durationMs / frameMs) + 1);

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
      const tgt = targetAt(simT * 1000, shots, gaps, cfg, cx, cy);
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
