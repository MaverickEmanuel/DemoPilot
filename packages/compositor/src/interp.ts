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

// ----------------------------------------------------------------------------
// Zoom — a calm, activity-driven focus envelope.
//
// Clicks and typing are "points of action". Each contributes a window; nearby
// windows merge into one sustained zoom so the view doesn't pump in and out
// between rapid steps. Navigations cut the envelope, so a zoom started on one
// page eases out as the page transitions instead of lingering over the next one.
// The origin tracks a time-smoothed cursor position, so the zoom focuses on
// whatever the cursor is doing (a field while typing, a button at a click) and
// keeps the cursor itself comfortably inside the frame.
// ----------------------------------------------------------------------------

export interface ZoomState {
  scale: number;
  originX: number;
  originY: number;
}

const ZOOM_MAX = 1.13;
const LEAD_MS = 450; // anticipate: begin easing in before the action
const TAIL_MS = 650; // linger briefly after the action
const EASE_IN_MS = 460;
const EASE_OUT_MS = 620;
const MERGE_GAP_MS = 2600; // actions closer than this share one sustained zoom
const ORIGIN_SMOOTH_MS = 320;

interface Interval {
  start: number;
  end: number;
}

function zoomIntervals(timeline: Timeline): Interval[] {
  const markers: number[] = [];
  for (const e of timeline.events) if (e.kind === "click" || e.kind === "type") markers.push(e.t);
  markers.sort((a, b) => a - b);
  if (markers.length === 0) return [];

  const navs: number[] = timeline.events.filter((e) => e.kind === "navigate").map((e) => e.t);
  const navBetween = (a: number, b: number) => navs.some((tn) => tn > a && tn < b);

  // Group consecutive actions, breaking the group across a navigation.
  const groups: number[][] = [[markers[0]]];
  for (let i = 1; i < markers.length; i++) {
    const prev = markers[i - 1];
    const cur = markers[i];
    if (cur - prev < MERGE_GAP_MS && !navBetween(prev, cur)) groups[groups.length - 1].push(cur);
    else groups.push([cur]);
  }

  return groups.map((g) => {
    const first = g[0];
    const last = g[g.length - 1];
    let start = first - LEAD_MS;
    let end = last + TAIL_MS;
    // Don't anticipate earlier than the page we're acting on appeared.
    const navBefore = Math.max(-Infinity, ...navs.filter((tn) => tn <= first));
    if (Number.isFinite(navBefore)) start = Math.max(start, navBefore);
    // End the zoom when the page changes right after the action (smooth handoff
    // to the next page instead of a stale zoom lingering over it).
    const navAfter = Math.min(Infinity, ...navs.filter((tn) => tn >= last));
    if (Number.isFinite(navAfter)) end = Math.min(end, navAfter);
    return { start, end };
  });
}

/** Time-smoothed cursor position, clamped to a safe inset, for the zoom origin. */
function focusOrigin(timeline: Timeline, tMs: number): Vec {
  const offsets = [-ORIGIN_SMOOTH_MS, -ORIGIN_SMOOTH_MS / 2, 0, ORIGIN_SMOOTH_MS / 2, ORIGIN_SMOOTH_MS];
  const weights = [0.5, 0.85, 1, 0.85, 0.5];
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let i = 0; i < offsets.length; i++) {
    const p = cursorAt(timeline.cursor, tMs + offsets[i]);
    sx += p.x * weights[i];
    sy += p.y * weights[i];
    sw += weights[i];
  }
  const x = sx / sw;
  const y = sy / sw;
  return {
    x: clamp(x, timeline.width * 0.12, timeline.width * 0.88),
    y: clamp(y, timeline.height * 0.14, timeline.height * 0.86),
  };
}

/** Subtle, smooth zoom envelope focused on the current point of action. */
export function zoomAt(timeline: Timeline, tMs: number): ZoomState {
  const intervals = zoomIntervals(timeline);
  let k = 0;
  for (const iv of intervals) {
    if (tMs < iv.start || tMs > iv.end) continue;
    const span = iv.end - iv.start;
    const easeIn = Math.min(EASE_IN_MS, span * 0.5);
    const easeOut = Math.min(EASE_OUT_MS, span * 0.5);
    const up = smoothstep(iv.start, iv.start + easeIn, tMs);
    const down = smoothstep(iv.end, iv.end - easeOut, tMs);
    k = Math.max(k, Math.min(up, down));
  }

  if (k <= 0) {
    return { scale: 1, originX: timeline.width / 2, originY: timeline.height / 2 };
  }
  const origin = focusOrigin(timeline, tMs);
  return { scale: 1 + (ZOOM_MAX - 1) * k, originX: origin.x, originY: origin.y };
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
