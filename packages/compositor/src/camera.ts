// ----------------------------------------------------------------------------
// Spring-physics tracking camera
//
// The camera frames one action group at a time. Each group gets a single anchor
// (the center of its members' union box) and an adaptive depth (small targets
// zoom deeper, large regions shallower). A critically-ish-damped spring chases a
// time-varying *target*, which produces the motion:
//
//   • within a group        → hold: target = that group's anchor + depth
//   • between near groups    → PAN: target morphs anchor/depth toward the next
//                              group while staying zoomed (spring glides over)
//   • between far groups      → HYBRID: a brief establishing beat eases the depth
//                              out to `establishLevel`, glides, then eases back in
//   • before/after the demo  → wide (scale 1)
//
// Navigations always cut a group, so the camera never drags a zoom across a page
// transition. The whole spring is simulated once into a uniform keyframe track;
// `cameraAt` samples it per frame.
// ----------------------------------------------------------------------------

import type { Timeline, ZoomConfig, Box } from "./types";
import { buildActionGroups, type ActionGroup, type Vec } from "./groups";

export interface CameraState {
  scale: number;
  originX: number;
  originY: number;
}

export interface CameraTrack {
  fps: number;
  /** Uniformly spaced (1/fps) keyframes from t=0 to durationMs. */
  frames: CameraState[];
  cursorScale: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;

// Aesthetic insets so the focal point is never jammed into a corner.
const SAFE_X = 0.12;
const SAFE_Y = 0.14;
// Lead-in before a group's first action and tail after its last (cinematic hold).
const LEAD_MS = 360;
const TAIL_MS = 700;
// Minimum establishing gap carved out for a far (zoom-out) handoff.
const GAP_MIN_MS = 220;
// Box padding before computing depth, for a little breathing room.
const BOX_PAD = 1.1;

interface Resolved {
  minZoom: number;
  maxZoom: number;
  fill: number;
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
    minZoom: z?.minZoom ?? 1.15,
    maxZoom: z?.maxZoom ?? Math.max(1.15, level > 1.25 ? level : 1.85),
    fill: z?.fill ?? 0.5,
    establishLevel: z?.establishLevel ?? 1.06,
    panThreshold: z?.panThreshold ?? 0.42,
    stiffness: z?.stiffness ?? 8,
    damping: z?.damping ?? 0.92,
    groupGapMs: z?.groupGapMs ?? 1800,
    cursorScale: z?.cursorScale ?? 1.5,
  };
}

function depthFor(bbox: Box, vw: number, vh: number, cfg: Resolved): number {
  const bw = Math.max(1, bbox.width * BOX_PAD);
  const bh = Math.max(1, bbox.height * BOX_PAD);
  const s = Math.min((vw * cfg.fill) / bw, (vh * cfg.fill) / bh);
  return clamp(s, cfg.minZoom, cfg.maxZoom);
}

function anchorFor(bbox: Box, vw: number, vh: number): Vec {
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  return {
    x: clamp(cx, vw * SAFE_X, vw * (1 - SAFE_X)),
    y: clamp(cy, vh * SAFE_Y, vh * (1 - SAFE_Y)),
  };
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
      anchor: anchorFor(g.bbox, vw, vh),
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
      return { scale: s.level, originX: s.anchor.x, originY: s.anchor.y };
    }
  }
  for (const g of gaps) {
    if (t > g.start && t < g.end) {
      const u = (t - g.start) / Math.max(1, g.end - g.start);
      const ax = lerp(g.from.anchor.x, g.to.anchor.x, u);
      const ay = lerp(g.from.anchor.y, g.to.anchor.y, u);
      if (g.far) {
        // Ease the depth out toward `establishLevel` and back in across the gap,
        // while gliding the focus toward the destination.
        const dome = Math.sin(Math.PI * u); // 0 → 1 → 0
        const base = lerp(g.from.level, g.to.level, u);
        const scale = lerp(base, cfg.establishLevel, dome);
        return { scale, originX: ax, originY: ay };
      }
      // Near: stay zoomed and pan — morph depth and anchor together.
      return { scale: lerp(g.from.level, g.to.level, u), originX: ax, originY: ay };
    }
  }
  // Idle (before first shot / after last): wide, centered.
  return { scale: 1, originX: cx, originY: cy };
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
      [x, vx] = step(x, vx, tgt.originX, dt);
      [y, vy] = step(y, vy, tgt.originY, dt);
      simT += dt;
    }
    frames.push({ scale: Math.max(1, s), originX: x, originY: y });
  }

  return { fps, frames, cursorScale: cfg.cursorScale };
}

/** Samples the precomputed camera track at time `tMs` (linear between frames). */
export function cameraAt(track: CameraTrack, tMs: number): CameraState {
  const { frames, fps } = track;
  if (frames.length === 0) return { scale: 1, originX: 0, originY: 0 };
  const idx = (tMs / 1000) * fps;
  if (idx <= 0) return frames[0];
  if (idx >= frames.length - 1) return frames[frames.length - 1];
  const i = Math.floor(idx);
  const u = idx - i;
  const a = frames[i];
  const b = frames[i + 1];
  return {
    scale: lerp(a.scale, b.scale, u),
    originX: lerp(a.originX, b.originX, u),
    originY: lerp(a.originY, b.originY, u),
  };
}

/** Resolves just the cursor magnification (used when the camera is disabled). */
export function cursorScaleOf(timeline: Timeline): number {
  return resolve(timeline.zoom).cursorScale;
}
