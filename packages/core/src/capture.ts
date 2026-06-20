import { chromium, type Browser, type BrowserContext, type Page, type CDPSession } from "playwright";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

/** Where the bundled ffmpeg lives (resolved by the caller from Remotion). */
export interface FfmpegLocation {
  bin: string;
  libDir: string;
}

export type CaptureMode = "recordVideo" | "screencast";

export interface RecordingSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Closes everything and resolves to the saved (clean, cursor-less) video path. */
  finish(opts?: FinishOptions): Promise<string>;
}

export interface FinishOptions {
  /** Clock value (Date.now()) of timeline t=0, so screencast frames align. */
  alignToWall?: number;
  /** Total timeline duration (ms), so the clean video spans the full timeline. */
  durationMs?: number;
}

export interface RecordingOptions {
  videoDir: string;
  viewport: { width: number; height: number };
  headless?: boolean;
  storageStatePath?: string;
  /** Capture backend. Default "recordVideo" (Playwright's realtime VP8 webm). */
  mode?: CaptureMode;
  /** Constant frame rate (fps) for the assembled screencast video. Default 30. */
  fps?: number;
  /** Remotion's bundled ffmpeg, required for "screencast" assembly. */
  ffmpeg?: FfmpegLocation;
  /** JPEG quality (1–100) for screencast frames. Default 95 (near-lossless). */
  screencastQuality?: number;
}

/**
 * Launches Chromium and records a cursor-less video of the page. Because
 * Playwright never renders a pointer, the recording is naturally clean and the
 * cursor is composited later from the timeline.
 *
 * Two backends:
 *  - "recordVideo" (default): Playwright's realtime VP8 webm. Simple, but
 *    realtime-encoded (softer text) and variable frame timing.
 *  - "screencast": CDP `Page.startScreencast` collects crisp JPEG frames with
 *    per-frame timestamps, assembled by Remotion's ffmpeg into a constant-fps
 *    MP4 — sharper text and uniform timing. Falls back is the caller's job.
 */
export async function startRecording(opts: RecordingOptions): Promise<RecordingSession> {
  await mkdir(opts.videoDir, { recursive: true });
  const mode: CaptureMode = opts.mode ?? "recordVideo";
  return mode === "screencast" ? startScreencast(opts) : startRecordVideo(opts);
}

// ----------------------------------------------------------------------------
// recordVideo backend (legacy, fallback)
// ----------------------------------------------------------------------------

async function startRecordVideo(opts: RecordingOptions): Promise<RecordingSession> {
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

// ----------------------------------------------------------------------------
// screencast backend (CDP frames -> constant-fps MP4 via Remotion's ffmpeg)
// ----------------------------------------------------------------------------

interface ScreencastFrame {
  /** Frame capture time in the Date.now() domain (aligned to the timeline). */
  tWall: number;
  data: Buffer;
}

async function startScreencast(opts: RecordingOptions): Promise<RecordingSession> {
  if (!opts.ffmpeg) {
    throw new Error("screencast capture requires an ffmpeg location (opts.ffmpeg)");
  }
  const ffmpeg = opts.ffmpeg;
  const fps = opts.fps ?? 30;
  const quality = opts.screencastQuality ?? 95;

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext({
    viewport: opts.viewport,
    storageState: opts.storageStatePath,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);

  const frames: ScreencastFrame[] = [];
  // Map the CDP monotonic clock onto Date.now() using the first frame as anchor,
  // so frame spacing stays accurate (monotonic) while the absolute origin lines
  // up with the timeline's wall clock.
  let monoToWall: number | null = null;

  client.on("Page.screencastFrame", async (params) => {
    const meta = params.metadata as { timestamp?: number };
    const tsMs = (meta.timestamp ?? 0) * 1000;
    if (monoToWall === null) monoToWall = Date.now() - tsMs;
    frames.push({ tWall: tsMs + monoToWall, data: Buffer.from(params.data, "base64") });
    try {
      await client.send("Page.screencastFrameAck", { sessionId: params.sessionId });
    } catch {
      // The session can close mid-flight on teardown; dropping the ack is fine.
    }
  });

  await client.send("Page.startScreencast", {
    format: "jpeg",
    quality,
    everyNthFrame: 1,
  });

  return {
    browser,
    context,
    page,
    async finish(finishOpts?: FinishOptions): Promise<string> {
      try {
        await client.send("Page.stopScreencast");
      } catch {
        /* already stopping */
      }
      // Let any in-flight frames settle, then tear down the browser.
      await new Promise((r) => setTimeout(r, 60));
      await context.close();
      await browser.close();

      return assembleConstantFps(frames, {
        videoDir: opts.videoDir,
        fps,
        ffmpeg,
        alignToWall: finishOpts?.alignToWall,
        durationMs: finishOpts?.durationMs,
      });
    },
  };
}

interface AssembleOptions {
  videoDir: string;
  fps: number;
  ffmpeg: FfmpegLocation;
  alignToWall?: number;
  durationMs?: number;
}

/**
 * Assembles paint-driven (variable-interval) JPEG frames into a constant-fps
 * MP4. Static stretches are padded by holding the most recent frame, so timing
 * stays uniform and aligned to the timeline.
 */
async function assembleConstantFps(frames: ScreencastFrame[], opts: AssembleOptions): Promise<string> {
  if (frames.length === 0) throw new Error("screencast produced no frames");

  const anchor = opts.alignToWall ?? frames[0].tWall;
  // Relative frame times (ms from timeline t=0), clamped and non-decreasing.
  const times = frames.map((f) => Math.max(0, f.tWall - anchor));
  const total = Math.max(opts.durationMs ?? times[times.length - 1], times[times.length - 1] + 1);

  const framesDir = join(opts.videoDir, "frames");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  // Write each frame and build a concat list with per-frame hold durations.
  const minDur = 1 / (opts.fps * 4); // floor so concat never sees a zero duration
  const lines: string[] = [];
  let lastPath = "";
  for (let i = 0; i < frames.length; i++) {
    const path = join(framesDir, `f_${String(i).padStart(5, "0")}.jpg`);
    await writeFile(path, frames[i].data);
    lastPath = path;
    // Frame i is shown until the next frame's time (the first frame holds from 0;
    // the last frame holds until the full timeline duration).
    const startMs = i === 0 ? 0 : times[i];
    const endMs = i < frames.length - 1 ? times[i + 1] : total;
    const durSec = Math.max(minDur, (endMs - startMs) / 1000);
    lines.push(`file '${path}'`);
    lines.push(`duration ${durSec.toFixed(4)}`);
  }
  // The concat demuxer applies the last `duration` only if the file repeats.
  lines.push(`file '${lastPath}'`);

  const listPath = join(opts.videoDir, "frames.txt");
  await writeFile(listPath, lines.join("\n") + "\n", "utf8");

  const outPath = join(opts.videoDir, "clean.mp4");
  await runFfmpeg(
    opts.ffmpeg,
    [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-r", String(opts.fps),
      "-fps_mode", "cfr",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "medium",
      "-crf", "18",
      "-movflags", "+faststart",
      outPath,
    ],
  );
  await rm(framesDir, { recursive: true, force: true });
  return outPath;
}

function runFfmpeg(ffmpeg: FfmpegLocation, args: string[]): Promise<void> {
  // ffmpeg needs its bundled shared libraries on the dynamic-linker path.
  const libVar =
    process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : process.platform === "win32" ? "PATH" : "LD_LIBRARY_PATH";
  const prev = process.env[libVar];
  const env = { ...process.env, [libVar]: prev ? `${ffmpeg.libDir}:${prev}` : ffmpeg.libDir };

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.bin, args, { env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.split("\n").slice(-8).join("\n")}`));
    });
  });
}

// CDPSession is referenced for typing the screencast client.
export type { CDPSession };
