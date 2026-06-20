import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { fileURLToPath } from "node:url";
import { copyFile, mkdtemp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Timeline } from "./types.js";

export { resolveBundledFfmpeg, type FfmpegLocation } from "./ffmpeg.js";

export interface RenderDemoOptions {
  /** Path to the clean (cursor-less) webm from the player. */
  videoPath: string;
  /** The synchronized event timeline. */
  timeline: Timeline;
  /** Where to write the final MP4. */
  outPath: string;
  fps?: number;
  zoomOnClick?: boolean;
  captions?: boolean;
  /** Present the recording as an inset, framed app card (default true). */
  framed?: boolean;
  onProgress?: (ratio: number) => void;
  /**
   * Path to a Chrome/Chromium executable for Remotion to use. Defaults to
   * DEMOPILOT_CHROME. When unset, Remotion downloads its own Chrome Headless
   * Shell (requires network access to remotion.media).
   */
  browserExecutable?: string;
}

export interface RenderDemoResult {
  outPath: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

const entryPoint = fileURLToPath(new URL("./index.ts", import.meta.url));

/**
 * Renders the final MP4 by compositing the clean recording with the timeline.
 * Remotion drives its own bundled ffmpeg, so no system ffmpeg is required.
 */
export async function renderDemo(opts: RenderDemoOptions): Promise<RenderDemoResult> {
  const fps = opts.fps ?? 30;

  // Remotion's <OffthreadVideo> resolves assets via staticFile() against the
  // bundle's public dir, so stage the recording there under a stable name.
  const publicDir = await mkdtemp(join(tmpdir(), "demopilot-public-"));
  const videoFile = "recording.webm";
  await copyFile(opts.videoPath, join(publicDir, videoFile));

  const serveUrl = await bundle({ entryPoint, publicDir });

  const inputProps = {
    videoFile,
    timeline: opts.timeline,
    fps,
    zoomOnClick: opts.zoomOnClick ?? true,
    captions: opts.captions ?? true,
    framed: opts.framed ?? true,
  };

  const browserExecutable = opts.browserExecutable ?? process.env.DEMOPILOT_CHROME;

  const composition = await selectComposition({ serveUrl, id: "Demo", inputProps, browserExecutable });

  await mkdir(dirname(opts.outPath), { recursive: true });
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: opts.outPath,
    inputProps,
    browserExecutable,
    onProgress: opts.onProgress ? ({ progress }) => opts.onProgress!(progress) : undefined,
  });

  return {
    outPath: opts.outPath,
    width: composition.width,
    height: composition.height,
    fps,
    durationMs: opts.timeline.durationMs,
  };
}
