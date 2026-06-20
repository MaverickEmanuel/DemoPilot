import type { Page } from "playwright";
import type { DemoScript, Step } from "./schema.js";
import { startRecording } from "./capture.js";
import { TimelineRecorder, type Timeline } from "./timeline.js";
import { moveCursor, dwell, type Point } from "./engines/mouse.js";
import { typeText } from "./engines/typing.js";
import { resolveLocator, centerOf } from "./locators.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PlayResult {
  /** Path to the clean, cursor-less webm recording. */
  videoPath: string;
  /** Sidecar event timeline used by the compositor. */
  timeline: Timeline;
}

export interface PlayOptions {
  videoDir: string;
  headless?: boolean;
}

/**
 * Deterministically replays a DemoScript, producing a clean recording plus a
 * synchronized timeline. No LLM is involved — given stable app state, the same
 * script yields the same demo.
 */
export async function playDemo(script: DemoScript, opts: PlayOptions): Promise<PlayResult> {
  const session = await startRecording({
    videoDir: opts.videoDir,
    viewport: script.viewport,
    headless: opts.headless,
    storageStatePath: script.storageStatePath,
  });

  const recorder = new TimelineRecorder(script.viewport.width, script.viewport.height);
  let cursor: Point = { x: script.viewport.width / 2, y: script.viewport.height / 2 };
  recorder.sampleCursor(cursor.x, cursor.y);

  // Record every top-level navigation — including client-side ones (form submits,
  // SPA route changes) that no explicit `goto` step produces. The compositor uses
  // these to reset the zoom when the page context changes, so a zoom started on
  // one page never lingers over the next. `navigate()` de-dupes against the
  // explicit `goto` records below.
  session.page.on("framenavigated", (frame) => {
    if (frame === session.page.mainFrame()) recorder.navigate(frame.url());
  });

  try {
    // Brief lead-in so the recording doesn't start mid-motion.
    await sleep(400);

    for (const step of script.steps) {
      cursor = await runStep(session.page, recorder, script, step, cursor);
    }

    // Brief tail so the last action is readable before the cut.
    await sleep(700);
  } finally {
    // Always close the session so the video is flushed to disk.
  }

  const videoPath = await session.finish();
  return { videoPath, timeline: recorder.finish() };
}

async function runStep(
  page: Page,
  recorder: TimelineRecorder,
  script: DemoScript,
  step: Step,
  cursor: Point,
): Promise<Point> {
  const { defaults } = script;

  if ("goto" in step) {
    const url = new URL(step.goto, script.baseUrl).toString();
    await page.goto(url, { waitUntil: "load" });
    recorder.navigate(url);
    await sleep(defaults.readPause);
    return cursor;
  }

  if ("click" in step) {
    const locator = resolveLocator(page, step.click.target);
    const point = await centerOf(locator);
    cursor = await moveCursor(page, recorder, cursor, point, defaults.mousePace);
    await dwell();
    recorder.click(point.x, point.y, step.click.button ?? "left");
    await page.mouse.click(point.x, point.y, {
      button: step.click.button ?? "left",
      clickCount: step.click.clickCount ?? 1,
    });
    return cursor;
  }

  if ("type" in step) {
    const locator = resolveLocator(page, step.type.target);
    const point = await centerOf(locator);
    cursor = await moveCursor(page, recorder, cursor, point, defaults.mousePace);
    await dwell();
    await typeText(locator, recorder, step.type.text, step.type.cadence ?? defaults.typeCadence);
    return cursor;
  }

  if ("hover" in step) {
    const locator = resolveLocator(page, step.hover.target);
    const point = await centerOf(locator);
    cursor = await moveCursor(page, recorder, cursor, point, defaults.mousePace);
    await locator.hover();
    return cursor;
  }

  if ("press" in step) {
    await page.keyboard.press(step.press.keys);
    return cursor;
  }

  if ("scroll" in step) {
    if (step.scroll.target) {
      await resolveLocator(page, step.scroll.target).scrollIntoViewIfNeeded();
    } else if (step.scroll.to) {
      await page.evaluate(
        (to) => window.scrollTo({ top: to === "bottom" ? document.body.scrollHeight : 0, behavior: "smooth" }),
        step.scroll.to,
      );
    } else if (typeof step.scroll.by === "number") {
      await page.mouse.wheel(0, step.scroll.by);
    }
    recorder.scroll();
    await sleep(400);
    return cursor;
  }

  if ("select" in step) {
    const locator = resolveLocator(page, step.select.target);
    await locator.selectOption(step.select.label ? { label: step.select.label } : { value: step.select.value! });
    return cursor;
  }

  if ("waitFor" in step) {
    if (step.waitFor.target) {
      await resolveLocator(page, step.waitFor.target).waitFor({ state: step.waitFor.state ?? "visible" });
    }
    if (typeof step.waitFor.ms === "number") await sleep(step.waitFor.ms);
    return cursor;
  }

  if ("pause" in step) {
    await sleep(step.pause);
    return cursor;
  }

  if ("narrate" in step) {
    recorder.narrate(step.narrate);
    return cursor;
  }

  return cursor;
}
