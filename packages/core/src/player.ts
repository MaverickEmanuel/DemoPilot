import type { Page } from "playwright";
import type { DemoScript, Step } from "./schema.js";
import { startRecording, type CaptureMode, type FfmpegLocation } from "./capture.js";
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
  /** Capture backend: "recordVideo" (default) or "screencast" (CDP, crisper + CFR). */
  capture?: CaptureMode;
  /** Constant frame rate for the screencast backend (default 30). */
  fps?: number;
  /** Remotion's bundled ffmpeg, required when capture is "screencast". */
  ffmpeg?: FfmpegLocation;
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
    mode: opts.capture,
    fps: opts.fps,
    ffmpeg: opts.ffmpeg,
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

  const scale = scaler(script.defaults.speed);
  try {
    // Lead-in so the recording doesn't start mid-motion.
    await sleep(scale(500));

    for (const step of script.steps) {
      cursor = await runStep(session.page, recorder, script, step, cursor);
    }

    // Tail so the last action lingers, readable, before the cut.
    await sleep(scale(1000));
  } finally {
    // Always close the session so the video is flushed to disk.
  }

  // Finalize the timeline first; its duration tells the screencast assembler how
  // long the clean video should be, and its t=0 anchors the frame alignment.
  const timeline = recorder.finish();
  // Carry the resolved zoom config to the compositor (and the sidecar
  // timeline.json) so the render's zoom intensity is authorable per demo.
  timeline.zoom = { level: script.defaults.zoom.level };
  const videoPath = await session.finish({ alignToWall: recorder.startedAt, durationMs: timeline.durationMs });
  return { videoPath, timeline };
}

/** Builds a duration scaler from the global speed multiplier (faster > 1, slower < 1). */
function scaler(speed: number): (ms: number) => number {
  return (ms: number) => Math.round(ms / speed);
}

async function runStep(
  page: Page,
  recorder: TimelineRecorder,
  script: DemoScript,
  step: Step,
  cursor: Point,
): Promise<Point> {
  const { defaults } = script;
  const speed = defaults.speed;
  const scale = scaler(speed);

  if ("goto" in step) {
    const url = new URL(step.goto, script.baseUrl).toString();
    await page.goto(url, { waitUntil: "load" });
    recorder.navigate(url);
    // Reading pause: let the freshly-loaded page register before acting on it.
    await sleep(scale(defaults.readPause));
    return cursor;
  }

  if ("click" in step) {
    const locator = resolveLocator(page, step.click.target);
    const point = await centerOf(locator);
    cursor = await moveCursor(page, recorder, cursor, point, defaults.mousePace, speed);
    // Pre-action dwell: a beat with the cursor on target before it commits.
    await dwell(scale(defaults.preActionDwell));
    recorder.click(point.x, point.y, step.click.button ?? "left");
    const urlBefore = page.url();
    await page.mouse.click(point.x, point.y, {
      button: step.click.button ?? "left",
      clickCount: step.click.clickCount ?? 1,
    });
    await holdAfterClick(page, scale, defaults, urlBefore);
    return cursor;
  }

  if ("type" in step) {
    const locator = resolveLocator(page, step.type.target);
    const point = await centerOf(locator);
    cursor = await moveCursor(page, recorder, cursor, point, defaults.mousePace, speed);
    await dwell(scale(defaults.preActionDwell));
    await typeText(locator, recorder, step.type.text, step.type.cadence ?? defaults.typeCadence, speed);
    // Post-action hold: let the typed value sit, readable, before moving on.
    await sleep(scale(defaults.postActionHold));
    return cursor;
  }

  if ("hover" in step) {
    const locator = resolveLocator(page, step.hover.target);
    const point = await centerOf(locator);
    cursor = await moveCursor(page, recorder, cursor, point, defaults.mousePace, speed);
    await dwell(scale(defaults.preActionDwell));
    await locator.hover();
    return cursor;
  }

  if ("press" in step) {
    await page.keyboard.press(step.press.keys);
    await sleep(scale(defaults.postActionHold));
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
    await sleep(scale(400));
    return cursor;
  }

  if ("select" in step) {
    const locator = resolveLocator(page, step.select.target);
    await locator.selectOption(step.select.label ? { label: step.select.label } : { value: step.select.value! });
    await sleep(scale(defaults.postActionHold));
    return cursor;
  }

  if ("waitFor" in step) {
    if (step.waitFor.target) {
      await resolveLocator(page, step.waitFor.target).waitFor({ state: step.waitFor.state ?? "visible" });
    }
    // `waitFor.ms` is author-controlled (often app-synchronized), so it is left
    // literal — the global speed multiplier does not scale it.
    if (typeof step.waitFor.ms === "number") await sleep(step.waitFor.ms);
    return cursor;
  }

  if ("pause" in step) {
    // Explicit author pause, left literal (not speed-scaled) by design.
    await sleep(step.pause);
    return cursor;
  }

  if ("narrate" in step) {
    recorder.narrate(step.narrate);
    return cursor;
  }

  if ("zoom" in step) {
    // Post-production marker only: it has no effect on the live page, it just
    // brackets an authored zoom region for the compositor.
    recorder.zoom(step.zoom);
    return cursor;
  }

  return cursor;
}

/**
 * After a click, wait for a possible client-side navigation (form submit / SPA
 * route change) to commit, then hold: a navigation earns the longer reading
 * pause (it lands on a new page to read); an in-place change (modal open, list
 * update) earns the shorter post-action hold. The `framenavigated` listener in
 * `playDemo` records the navigation itself onto the timeline, so the compositor
 * stays in sync regardless.
 */
async function holdAfterClick(
  page: Page,
  scale: (ms: number) => number,
  defaults: DemoScript["defaults"],
  urlBefore: string,
): Promise<void> {
  // Give a synchronous navigation a beat to start, then settle on the load.
  await sleep(scale(120));
  await page.waitForLoadState("load").catch(() => {});
  const navigated = page.url() !== urlBefore;
  await sleep(scale(navigated ? defaults.readPause : defaults.postActionHold));
}
