import type { Timeline, CursorSample } from "./types";

export interface Vec {
  x: number;
  y: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** Smooth Hermite ramp; 0 at a, 1 at b (works for a>b too). */
function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x >= a ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ----------------------------------------------------------------------------
// Cursor position — centripetal Catmull-Rom through the recorded samples.
//
// The samples already lie on the player's easing curve in the time domain (the
// player advances position by real elapsed time), so the remaining job here is
// to remove the per-sample velocity corners that linear interpolation leaves
// behind. Centripetal Catmull-Rom (alpha = 0.5) gives a C1-continuous path that
// passes through every sample exactly — so click points (which are samples) stay
// pixel-accurate — without the cusps or overshoot that uniform splines produce.
// ----------------------------------------------------------------------------

function lerpKnot(a: Vec, b: Vec, ta: number, tb: number, t: number): Vec {
  const d = tb - ta;
  if (Math.abs(d) < 1e-9) return a;
  const w = (t - ta) / d;
  return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
}

function knot(prev: number, a: Vec, b: Vec): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  // alpha = 0.5 (centripetal); floor keeps coincident points from collapsing.
  return prev + Math.sqrt(Math.max(d, 1e-4));
}

function catmullRom(p0: Vec, p1: Vec, p2: Vec, p3: Vec, s: number): Vec {
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const t = t1 + s * (t2 - t1);
  const a1 = lerpKnot(p0, p1, t0, t1, t);
  const a2 = lerpKnot(p1, p2, t1, t2, t);
  const a3 = lerpKnot(p2, p3, t2, t3, t);
  const b1 = lerpKnot(a1, a2, t0, t2, t);
  const b2 = lerpKnot(a2, a3, t1, t3, t);
  return lerpKnot(b1, b2, t1, t2, t);
}

/** Smoothly interpolates the cursor position at time `tMs`. */
export function cursorAt(samples: CursorSample[], tMs: number): Vec {
  const n = samples.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1 || tMs <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[n - 1];
  if (tMs >= last.t) return { x: last.x, y: last.y };

  let i = 0;
  for (; i < n - 1; i++) if (samples[i + 1].t >= tMs) break;

  const p1 = samples[i];
  const p2 = samples[i + 1];
  const span = p2.t - p1.t || 1;
  const s = clamp((tMs - p1.t) / span, 0, 1);

  // Reflect at the ends so the spline has a natural tangent there.
  const p0 = samples[i - 1] ?? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
  const p3 = samples[i + 2] ?? { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
  return catmullRom(p0, p1, p2, p3, s);
}

// ----------------------------------------------------------------------------
// Click ripple
// ----------------------------------------------------------------------------

export interface ClickPulse {
  /** 0..1 progress of the most recent ripple, or null if none active. */
  progress: number;
  x: number;
  y: number;
}

const RIPPLE_MS = 480;
/** A click that navigates within this window is a transition — skip its ripple. */
const NAV_SUPPRESS_MS = 320;

/** Returns the active click ripple (if any) at time `tMs`. */
export function clickPulseAt(timeline: Timeline, tMs: number): ClickPulse | null {
  let active: ClickPulse | null = null;
  for (const e of timeline.events) {
    if (e.kind !== "click") continue;
    // Suppress ripples for clicks that immediately trigger a navigation: the
    // page changes underneath, so the ripple would float over unrelated content.
    const navigates = timeline.events.some(
      (n) => n.kind === "navigate" && n.t > e.t && n.t - e.t <= NAV_SUPPRESS_MS,
    );
    if (navigates) continue;
    const dt = tMs - e.t;
    if (dt >= 0 && dt <= RIPPLE_MS) active = { progress: dt / RIPPLE_MS, x: e.x, y: e.y };
  }
  return active;
}

/** Duration of the cursor press scale-pop. */
const PRESS_POP_MS = 140;

/** A smooth click scale-pop amount (0→1→0 over ~140 ms) at time `tMs`, peaking
 * shortly after each click. Drives the cursor's press dip. */
export function cursorPressAt(timeline: Timeline, tMs: number): number {
  let pop = 0;
  for (const e of timeline.events) {
    if (e.kind !== "click") continue;
    const dt = tMs - e.t;
    if (dt >= 0 && dt <= PRESS_POP_MS) pop = Math.max(pop, Math.sin(Math.PI * (dt / PRESS_POP_MS)));
  }
  return pop;
}

// ----------------------------------------------------------------------------
// Captions
// ----------------------------------------------------------------------------

export interface CaptionState {
  text: string;
  opacity: number;
}

const CAPTION_MAX_MS = 3600;
const CAPTION_FADE_MS = 260;

/** The caption to show at time `tMs` (with fade), or null. */
export function captionAt(timeline: Timeline, tMs: number): CaptionState | null {
  const narrations = timeline.events.filter((e) => e.kind === "narrate") as Array<{
    t: number;
    text: string;
  }>;
  for (let i = 0; i < narrations.length; i++) {
    const cur = narrations[i];
    const next = narrations[i + 1];
    // A caption holds until the next narration begins, capped at a max duration.
    const end = Math.min(cur.t + CAPTION_MAX_MS, next ? next.t : Infinity);
    if (tMs < cur.t || tMs >= end) continue;
    const fadeIn = smoothstep(cur.t, cur.t + CAPTION_FADE_MS, tMs);
    const fadeOut = smoothstep(end, end - CAPTION_FADE_MS, tMs);
    return { text: cur.text, opacity: Math.min(fadeIn, fadeOut) };
  }
  return null;
}

/** When the real content first appears (first navigation), for the intro cover. */
export function contentStartMs(timeline: Timeline): number {
  const firstNav = timeline.events.find((e) => e.kind === "navigate");
  return firstNav ? firstNav.t : 0;
}
