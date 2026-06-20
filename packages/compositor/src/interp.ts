import type { Timeline, CursorSample } from "./types";

/** Linearly interpolates the cursor position at time `tMs`. */
export function cursorAt(samples: CursorSample[], tMs: number): { x: number; y: number } {
  if (samples.length === 0) return { x: 0, y: 0 };
  if (tMs <= samples[0].t) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (tMs >= last.t) return { x: last.x, y: last.y };

  // Linear scan is fine for typical demo lengths.
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i];
    if (b.t >= tMs) {
      const a = samples[i - 1];
      const span = b.t - a.t || 1;
      const p = (tMs - a.t) / span;
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
    }
  }
  return { x: last.x, y: last.y };
}

export interface ClickPulse {
  /** 0..1 progress of the most recent ripple, or null if none active. */
  progress: number;
  x: number;
  y: number;
}

const RIPPLE_MS = 600;

/** Returns the active click ripple (if any) at time `tMs`. */
export function clickPulseAt(timeline: Timeline, tMs: number): ClickPulse | null {
  let active: ClickPulse | null = null;
  for (const e of timeline.events) {
    if (e.kind !== "click") continue;
    const dt = tMs - e.t;
    if (dt >= 0 && dt <= RIPPLE_MS) active = { progress: dt / RIPPLE_MS, x: e.x, y: e.y };
  }
  return active;
}

export interface ZoomState {
  scale: number;
  originX: number;
  originY: number;
}

const ZOOM_IN_MS = 260;
const ZOOM_HOLD_MS = 900;
const ZOOM_OUT_MS = 360;
const ZOOM_MAX = 1.12;

/** Subtle zoom-toward-cursor envelope around the nearest click. */
export function zoomAt(timeline: Timeline, tMs: number): ZoomState {
  for (const e of timeline.events) {
    if (e.kind !== "click") continue;
    const dt = tMs - e.t;
    if (dt < 0 || dt > ZOOM_IN_MS + ZOOM_HOLD_MS + ZOOM_OUT_MS) continue;
    let amount: number;
    if (dt < ZOOM_IN_MS) amount = dt / ZOOM_IN_MS;
    else if (dt < ZOOM_IN_MS + ZOOM_HOLD_MS) amount = 1;
    else amount = 1 - (dt - ZOOM_IN_MS - ZOOM_HOLD_MS) / ZOOM_OUT_MS;
    const scale = 1 + (ZOOM_MAX - 1) * Math.max(0, Math.min(1, amount));
    return { scale, originX: e.x, originY: e.y };
  }
  return { scale: 1, originX: timeline.width / 2, originY: timeline.height / 2 };
}

/** The caption to show at time `tMs`, or null. */
export function captionAt(timeline: Timeline, tMs: number, holdMs = 3200): string | null {
  let current: { t: number; text: string } | null = null;
  for (const e of timeline.events) {
    if (e.kind !== "narrate") continue;
    if (e.t <= tMs) current = { t: e.t, text: e.text };
  }
  if (current && tMs - current.t <= holdMs) return current.text;
  return null;
}
