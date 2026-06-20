import type { Page } from "playwright";
import type { MousePace } from "../schema.js";
import type { TimelineRecorder } from "../timeline.js";

export interface Point {
  x: number;
  y: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

const PACE: Record<MousePace, { pxPerMs: number }> = {
  // Tuned for a calm, deliberate feel: long cross-screen travels glide rather
  // than dart. Short hops are governed by the duration floor below, so lowering
  // this only slows the big moves.
  natural: { pxPerMs: 1.5 },
  fast: { pxPerMs: 3.6 },
  instant: { pxPerMs: Infinity },
};

const FRAME_MS = 16; // ~60fps sampling cadence for the path

/**
 * Moves the (real) Playwright pointer from `from` to `to` along an eased path,
 * sampling each intermediate position into the timeline so the compositor can
 * redraw a smooth cursor later. Returns the final point.
 *
 * The app sees genuine pointer movement (so hover states fire); the cursor the
 * viewer sees is drawn in post from the samples.
 *
 * Position is advanced by **real elapsed time** (not by frame index): each
 * `page.mouse.move` is an async CDP round-trip of variable latency, so a path
 * progressed by `i/frames` would place evenly-spaced positions at *unevenly*
 * spaced timestamps — and the compositor, which interpolates by time, would then
 * render visible velocity jitter. Sampling `ease(elapsed/duration)` keeps every
 * recorded sample on the intended easing curve in the time domain, so the
 * composited cursor glides with a continuous, natural velocity.
 */
export async function moveCursor(
  page: Page,
  recorder: TimelineRecorder,
  from: Point,
  to: Point,
  pace: MousePace,
  speed = 1,
): Promise<Point> {
  const { pxPerMs } = PACE[pace];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  if (pace === "instant" || distance < 1) {
    await page.mouse.move(to.x, to.y);
    recorder.sampleCursor(to.x, to.y);
    return to;
  }

  // Longer travels take proportionally longer, clamped to a calm, readable range.
  // The global `speed` multiplier scales the whole travel (faster > 1, slower < 1).
  const duration = Math.min(1400, Math.max(180, distance / pxPerMs)) / speed;

  // Anchor the start position at the move's start time so the idle→move
  // transition is crisp (the compositor holds, then begins moving exactly here).
  recorder.sampleCursor(from.x, from.y);

  const start = Date.now();
  for (;;) {
    await sleep(FRAME_MS);
    const p = Math.min(1, (Date.now() - start) / duration);
    const e = easeInOutCubic(p);
    const x = from.x + dx * e;
    const y = from.y + dy * e;
    await page.mouse.move(x, y);
    recorder.sampleCursor(x, y);
    if (p >= 1) break;
  }

  return to;
}

/**
 * A pre-action dwell of roughly `ms`, with a little humanizing jitter (±15%) so
 * repeated actions don't tick like a metronome. Callers pass an already
 * speed-scaled duration. A `ms` of 0 dwells not at all.
 */
export async function dwell(ms = 450): Promise<void> {
  if (ms <= 0) return;
  const jitter = ms * 0.15;
  await sleep(ms - jitter + Math.random() * 2 * jitter);
}
