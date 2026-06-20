import type { Locator } from "playwright";
import type { TypeCadence } from "../schema.js";
import type { TimelineRecorder } from "../timeline.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CADENCE: Record<TypeCadence, { base: number; jitter: number }> = {
  human: { base: 70, jitter: 80 },
  fast: { base: 25, jitter: 20 },
  instant: { base: 0, jitter: 0 },
};

/**
 * Types into a focused locator with human-like, per-character timing. Records a
 * single `type` event (with the final text) on the timeline for captions/zoom.
 */
export async function typeText(
  locator: Locator,
  recorder: TimelineRecorder,
  text: string,
  cadence: TypeCadence,
  speed = 1,
): Promise<void> {
  await locator.click();
  const { base, jitter } = CADENCE[cadence];

  if (cadence === "instant") {
    await locator.fill(text);
  } else {
    for (const ch of text) {
      await locator.pressSequentially(ch, { delay: 0 });
      // Slightly longer pauses after word boundaries read as natural. The global
      // `speed` multiplier scales the per-character cadence (faster > 1, slower < 1).
      const extra = ch === " " ? jitter : 0;
      await sleep((base + Math.random() * jitter + extra) / speed);
    }
  }

  recorder.type(text);
}
