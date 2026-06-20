import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

export interface RecordingSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Closes everything and resolves to the saved (clean, cursor-less) webm path. */
  finish(): Promise<string>;
}

export interface RecordingOptions {
  videoDir: string;
  viewport: { width: number; height: number };
  headless?: boolean;
  storageStatePath?: string;
}

/**
 * Launches Chromium and a context that records a cursor-less webm of the page.
 * Because Playwright never renders a pointer, the recording is naturally clean
 * and the cursor is composited later from the timeline.
 */
export async function startRecording(opts: RecordingOptions): Promise<RecordingSession> {
  await mkdir(opts.videoDir, { recursive: true });
  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext({
    viewport: opts.viewport,
    storageState: opts.storageStatePath,
    recordVideo: { dir: opts.videoDir, size: opts.viewport },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async finish(): Promise<string> {
      const video = page.video();
      await context.close();
      await browser.close();
      if (!video) throw new Error("No video was recorded for this session");
      return video.path();
    },
  };
}
