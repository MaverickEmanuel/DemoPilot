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
// The origin is *anchored* to the bounding-box center of the group's actions,
// so the view stays composed on the form (the cursor moving between fields and
// the submit button doesn't make it pan). Authors can also force a region with
// `zoom: in` / `zoom: out` steps, which add their own interval to the mix.
// ----------------------------------------------------------------------------

export interface ZoomState {
  scale: number;
  originX: number;
  originY: number;
}

const ZOOM_MAX = 1.25; // default magnification; overridden by timeline.zoom.level
const LEAD_MS = 450; // anticipate: begin easing in before the action
const TAIL_MS = 900; // linger after the last action so it stays readable
const EASE_IN_MS = 460;
const EASE_OUT_MS = 620;
const MERGE_GAP_MS = 3200; // actions whose gap is under this share one sustained zoom
const SAFE_X = 0.12; // keep the focus point off the extreme horizontal edges
const SAFE_Y = 0.14;

/** A discrete action with a time span and a focus point (in video px). */
interface Action {
  start: number;
  end: number;
  x: number;
  y: number;
}

interface Interval {
  start: number;
  end: number;
  anchor: Vec;
}

/** Clicks (instant) and typing (a [tStart, t] span), each with a focus point. */
function actions(timeline: Timeline): Action[] {
  const out: Action[] = [];
  for (const e of timeline.events) {
    if (e.kind === "click") {
      out.push({ start: e.t, end: e.t, x: e.x, y: e.y });
    } else if (e.kind === "type") {
      // `type` events carry no coordinates; the player parks the cursor on the
      // field center before typing, so the cursor position there is the field.
      const p = cursorAt(timeline.cursor, e.tStart);
      out.push({ start: e.tStart, end: e.t, x: p.x, y: p.y });
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
  const acts = actions(timeline);
  const intervals: Interval[] = [];

  // --- Automatic: merge nearby action ranges into sustained zooms. ---
  if (acts.length > 0) {
    let group: Action[] = [acts[0]];
    const flush = () => {
      const first = group[0];
      const last = group.reduce((m, a) => (a.end > m.end ? a : m), group[0]);
      let start = first.start - LEAD_MS;
      let end = last.end + TAIL_MS;
      // Don't anticipate before the acted-on page appeared, and end the zoom
      // when the page changes right after, for a smooth handoff.
      const navBefore = Math.max(-Infinity, ...navs.filter((tn) => tn <= first.start));
      if (Number.isFinite(navBefore)) start = Math.max(start, navBefore);
      const navAfter = Math.min(Infinity, ...navs.filter((tn) => tn >= last.end));
      if (Number.isFinite(navAfter)) end = Math.min(end, navAfter);
      intervals.push({ start, end, anchor: anchorOf(group, timeline) });
    };
    for (let i = 1; i < acts.length; i++) {
      const prev = group[group.length - 1];
      const cur = acts[i];
      // Gap is measured edge-to-edge so a long typing run still merges with the
      // next field even though its completion timestamp is far from the start.
      if (cur.start - prev.end < MERGE_GAP_MS && !navBetween(prev.end, cur.start)) {
        group.push(cur);
      } else {
        flush();
        group = [cur];
      }
    }
    flush();
  }

  // --- Explicit: authored `zoom: in` / `zoom: out` regions. ---
  const markers = timeline.events.filter(
    (e): e is Extract<typeof e, { kind: "zoom" }> => e.kind === "zoom",
  );
  let openAt: number | null = null;
  for (const m of markers) {
    if (m.action === "in") {
      if (openAt === null) openAt = m.t;
    } else if (openAt !== null) {
      intervals.push(explicitInterval(openAt, m.t, acts, timeline));
      openAt = null;
    }
  }
  if (openAt !== null) {
    // An unmatched `in` holds to the end of the recording.
    intervals.push(explicitInterval(openAt, timeline.durationMs, acts, timeline));
  }

  return intervals;
}

function explicitInterval(start: number, end: number, acts: Action[], timeline: Timeline): Interval {
  const inside = acts.filter((a) => a.start >= start && a.start <= end);
  return { start, end, anchor: anchorOf(inside, timeline) };
}

/** Smooth zoom envelope anchored on the active group's region. */
export function zoomAt(timeline: Timeline, tMs: number): ZoomState {
  const intervals = zoomIntervals(timeline);
  const max = timeline.zoom?.level ?? ZOOM_MAX;
  let k = 0;
  let anchor: Vec | null = null;
  for (const iv of intervals) {
    if (tMs < iv.start || tMs > iv.end) continue;
    const span = iv.end - iv.start;
    const easeIn = Math.min(EASE_IN_MS, span * 0.5);
    const easeOut = Math.min(EASE_OUT_MS, span * 0.5);
    const up = smoothstep(iv.start, iv.start + easeIn, tMs);
    const down = smoothstep(iv.end, iv.end - easeOut, tMs);
    const kv = Math.min(up, down);
    // The strongest active interval owns the focus point, so overlapping
    // automatic + authored zooms resolve to one steady anchor.
    if (kv > k) {
      k = kv;
      anchor = iv.anchor;
    }
  }

  if (k <= 0 || !anchor) {
    return { scale: 1, originX: timeline.width / 2, originY: timeline.height / 2 };
  }
  return { scale: 1 + (max - 1) * k, originX: anchor.x, originY: anchor.y };
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
