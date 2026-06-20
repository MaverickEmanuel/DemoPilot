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

const PACE: Record<MousePace, { pxPerMs: number; overshoot: number }> = {
  natural: { pxPerMs: 1.8, overshoot: 0.06 },
  fast: { pxPerMs: 3.6, overshoot: 0 },
  instant: { pxPerMs: Infinity, overshoot: 0 },
};

const FRAME_MS = 16; // ~60fps sampling of the path

/**
 * Moves the (real) Playwright pointer from `from` to `to` along an eased path,
 * sampling each intermediate position into the timeline so the compositor can
 * redraw a smooth cursor later. Returns the final point.
 *
 * The app sees genuine pointer movement (so hover states fire); the cursor the
 * viewer sees is drawn in post from the samples.
 */
export async function moveCursor(
  page: Page,
  recorder: TimelineRecorder,
  from: Point,
  to: Point,
  pace: MousePace,
): Promise<Point> {
  const { pxPerMs, overshoot } = PACE[pace];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);

  if (pace === "instant" || distance < 1) {
    await page.mouse.move(to.x, to.y);
    recorder.sampleCursor(to.x, to.y);
    return to;
  }

  const duration = Math.min(1400, Math.max(180, distance / pxPerMs));
  const frames = Math.max(2, Math.round(duration / FRAME_MS));

  // Optionally aim slightly past the target, then settle back onto it.
  const over: Point = { x: to.x + dx * overshoot, y: to.y + dy * overshoot };

  // Main eased glide toward the (possibly overshot) aim point.
  for (let i = 1; i <= frames; i++) {
    const p = easeInOutCubic(i / frames);
    const x = from.x + (over.x - from.x) * p;
    const y = from.y + (over.y - from.y) * p;
    await page.mouse.move(x, y);
    recorder.sampleCursor(x, y);
    await sleep(FRAME_MS);
  }

  // Settle from the overshoot back onto the exact target.
  if (overshoot > 0) {
    const settleFrames = 3;
    for (let i = 1; i <= settleFrames; i++) {
      const p = i / settleFrames;
      const x = over.x + (to.x - over.x) * p;
      const y = over.y + (to.y - over.y) * p;
      await page.mouse.move(x, y);
      recorder.sampleCursor(x, y);
      await sleep(FRAME_MS);
    }
  }

  await page.mouse.move(to.x, to.y);
  recorder.sampleCursor(to.x, to.y);
  return to;
}

/** A short, human pre-click dwell. */
export async function dwell(min = 120, max = 260): Promise<void> {
  await sleep(min + Math.random() * (max - min));
}
