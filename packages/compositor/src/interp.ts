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
// Clicks and typing are "actions", each spanning a time range: a click is an
// instant, but typing runs from when it begins (`tStart`) to when it finishes
// (`t`), so the zoom holds for the whole field rather than blipping at the end.
// Nearby ranges merge into one sustained zoom, so a multi-field form (e.g. a
// login) reads as a single hold instead of pumping in and out between fields.
// Navigations cut the envelope, so a zoom started on one page eases out as the
// page transitions instead of lingering over the next one.
//
// Typing and clicks get *separate* zooms. A run of nearby fields shares one
// sustained zoom anchored on the form's bounding box, so it stays composed and
// doesn't pan. Each button click gets its own, slightly deeper zoom centered on
// the button itself, so important clicks punch in on the mouse. Overlapping
// zooms are blended (deepest wins the scale; the focus is weighted by how much
// each contributes), so the camera eases onto a button as its click punches in
// and back to the form afterward — no hard jumps. Authors can also force a
// region with `zoom: in` / `zoom: out` steps, which add their own interval.
// ----------------------------------------------------------------------------

export interface ZoomState {
  scale: number;
  originX: number;
  originY: number;
}

const ZOOM_MAX = 1.25; // default magnification; overridden by timeline.zoom.level
const CLICK_BOOST = 0.1; // default extra magnification for clicks, over the base level
const LEAD_MS = 450; // typing: begin easing in before the field
const TAIL_MS = 900; // typing: linger after the last field so it stays readable
// Bias the click punch to peak just *before* the press (while the cursor dwells
// on the target), so even a button that immediately navigates gets emphasized
// on the mouse before the page changes and the zoom is clipped.
const CLICK_LEAD_MS = 540; // click: begin punching in well before the press
const CLICK_TAIL_MS = 460; // click: ease back out shortly after
const EASE_IN_MS = 460;
const EASE_OUT_MS = 620;
const MERGE_GAP_MS = 3200; // type actions whose gap is under this share one sustained zoom
const SAFE_X = 0.12; // keep the focus point off the extreme horizontal edges
const SAFE_Y = 0.14;

/** A discrete action with a time span and a focus point (in video px). */
interface Action {
  kind: "click" | "type";
  start: number;
  end: number;
  x: number;
  y: number;
}

/** A zoom window: when it's active, where it focuses, and how deep it goes. */
interface Interval {
  start: number;
  end: number;
  anchor: Vec;
  level: number;
}

/** Clicks (instant) and typing (a [tStart, t] span), each with a focus point. */
function actions(timeline: Timeline): Action[] {
  const out: Action[] = [];
  for (const e of timeline.events) {
    if (e.kind === "click") {
      out.push({ kind: "click", start: e.t, end: e.t, x: e.x, y: e.y });
    } else if (e.kind === "type") {
      // `type` events carry no coordinates; the player parks the cursor on the
      // field center before typing, so the cursor position there is the field.
      const p = cursorAt(timeline.cursor, e.tStart);
      out.push({ kind: "type", start: e.tStart, end: e.t, x: p.x, y: p.y });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Bounding-box center of the given actions, clamped to a safe inset. */
function anchorOf(acts: Action[], timeline: Timeline): Vec {
  if (acts.length === 0) return { x: timeline.width / 2, y: timeline.height / 2 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const a of acts) {
    minX = Math.min(minX, a.x);
    maxX = Math.max(maxX, a.x);
    minY = Math.min(minY, a.y);
    maxY = Math.max(maxY, a.y);
  }
  return {
    x: clamp((minX + maxX) / 2, timeline.width * SAFE_X, timeline.width * (1 - SAFE_X)),
    y: clamp((minY + maxY) / 2, timeline.height * SAFE_Y, timeline.height * (1 - SAFE_Y)),
  };
}

function zoomIntervals(timeline: Timeline): Interval[] {
  const navs: number[] = timeline.events.filter((e) => e.kind === "navigate").map((e) => e.t);
  const navBetween = (a: number, b: number) => navs.some((tn) => tn > a && tn < b);
  // Clip a window so a zoom never anticipates before the acted-on page appeared
  // nor lingers past the navigation right after it (a smooth page handoff).
  const clipToNav = (start: number, end: number, refStart: number, refEnd: number) => {
    const navBefore = Math.max(-Infinity, ...navs.filter((tn) => tn <= refStart));
    if (Number.isFinite(navBefore)) start = Math.max(start, navBefore);
    const navAfter = Math.min(Infinity, ...navs.filter((tn) => tn >= refEnd));
    if (Number.isFinite(navAfter)) end = Math.min(end, navAfter);
    return { start, end };
  };

  const acts = actions(timeline);
  const base = timeline.zoom?.level ?? ZOOM_MAX;
  const clickLevel = base + (timeline.zoom?.clickBoost ?? CLICK_BOOST);
  const intervals: Interval[] = [];

  // --- Typing: merge nearby field ranges into one sustained, form-anchored zoom. ---
  const typeActs = acts.filter((a) => a.kind === "type");
  if (typeActs.length > 0) {
    let group: Action[] = [typeActs[0]];
    const flush = () => {
      const first = group[0];
      const last = group.reduce((m, a) => (a.end > m.end ? a : m), group[0]);
      // Gap is measured edge-to-edge so a long typing run still merges with the
      // next field even though its completion timestamp is far from the start.
      const win = clipToNav(first.start - LEAD_MS, last.end + TAIL_MS, first.start, last.end);
      intervals.push({ ...win, anchor: anchorOf(group, timeline), level: base });
    };
    for (let i = 1; i < typeActs.length; i++) {
      const prev = group[group.length - 1];
      const cur = typeActs[i];
      if (cur.start - prev.end < MERGE_GAP_MS && !navBetween(prev.end, cur.start)) group.push(cur);
      else {
        flush();
        group = [cur];
      }
    }
    flush();
  }

  // --- Clicks: each button click gets its own deeper zoom, centered on the button. ---
  for (const c of acts) {
    if (c.kind !== "click") continue;
    const win = clipToNav(c.start - CLICK_LEAD_MS, c.end + CLICK_TAIL_MS, c.start, c.end);
    intervals.push({ ...win, anchor: anchorOf([c], timeline), level: clickLevel });
  }

  // --- Explicit: authored `zoom: in` / `zoom: out` regions, at the base level. ---
  const markers = timeline.events.filter(
    (e): e is Extract<typeof e, { kind: "zoom" }> => e.kind === "zoom",
  );
  let openAt: number | null = null;
  for (const m of markers) {
    if (m.action === "in") {
      if (openAt === null) openAt = m.t;
    } else if (openAt !== null) {
      intervals.push(explicitInterval(openAt, m.t, acts, timeline, base));
      openAt = null;
    }
  }
  if (openAt !== null) {
    // An unmatched `in` holds to the end of the recording.
    intervals.push(explicitInterval(openAt, timeline.durationMs, acts, timeline, base));
  }

  return intervals;
}

function explicitInterval(
  start: number,
  end: number,
  acts: Action[],
  timeline: Timeline,
  level: number,
): Interval {
  const inside = acts.filter((a) => a.start >= start && a.start <= end);
  return { start, end, anchor: anchorOf(inside, timeline), level };
}

/** Smooth zoom envelope; blends overlapping intervals into one scale + focus. */
export function zoomAt(timeline: Timeline, tMs: number): ZoomState {
  const intervals = zoomIntervals(timeline);
  let scale = 1;
  let wx = 0;
  let wy = 0;
  let wSum = 0;
  for (const iv of intervals) {
    if (tMs < iv.start || tMs > iv.end) continue;
    const span = iv.end - iv.start;
    const easeIn = Math.min(EASE_IN_MS, span * 0.5);
    const easeOut = Math.min(EASE_OUT_MS, span * 0.5);
    const up = smoothstep(iv.start, iv.start + easeIn, tMs);
    const down = smoothstep(iv.end, iv.end - easeOut, tMs);
    const k = Math.min(up, down);
    if (k <= 0) continue;
    // The deepest active interval owns the scale; the focus is a weighted blend
    // by each interval's zoom contribution, so the origin eases toward a button
    // as its (deeper) click punches in and back to the form afterward.
    scale = Math.max(scale, 1 + (iv.level - 1) * k);
    const w = (iv.level - 1) * k;
    wx += iv.anchor.x * w;
    wy += iv.anchor.y * w;
    wSum += w;
  }

  if (wSum <= 0) {
    return { scale: 1, originX: timeline.width / 2, originY: timeline.height / 2 };
  }
  return { scale, originX: wx / wSum, originY: wy / wSum };
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
