import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { fileURLToPath } from "node:url";
import { copyFile, mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Timeline } from "./types.js";
import { buildAudioTrack, muxAudio, wantsAudio, type AudioOptions } from "./audio.js";
import { resolveBundledFfmpeg } from "./ffmpeg.js";

export { resolveBundledFfmpeg, type FfmpegLocation } from "./ffmpeg.js";
export type { AudioOptions } from "./audio.js";

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
  /** Named background preset (e.g. "aurora-mesh", "nebula", "ember", "dawn",
   * "mist", "spectrum", or the legacy "midnight"/"dusk"/"daylight"/"aurora") or a
   * raw CSS background string. Only used when framed. Defaults to a mesh preset. */
  background?: string;
  /** Subtly drift the mesh background's blobs over time (no-op for non-mesh). */
  backgroundDrift?: boolean;
  /** Motion blur mode. "synthetic" (default, ~1× cost) | "sampled" (samples× cost)
   * | "off". */
  motionBlur?: "synthetic" | "sampled" | "off";
  /** Subtle edge vignette for depth (default true). */
  vignette?: boolean;
  /** Audio: a soft music bed + click ticks by default; TTS voiceover opt-in.
   * Muxed on with Remotion's bundled ffmpeg; skipped (silent video) if ffmpeg
   * can't be resolved. See AudioOptions. */
  audio?: AudioOptions;
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
  const fps = opts.fps ?? 60;

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
    background: opts.background,
    backgroundDrift: opts.backgroundDrift ?? false,
    motionBlur: opts.motionBlur ?? "synthetic",
    vignette: opts.vignette ?? true,
  };

  const browserExecutable = opts.browserExecutable ?? process.env.DEMOPILOT_CHROME;

  const composition = await selectComposition({ serveUrl, id: "Demo", inputProps, browserExecutable });

  await mkdir(dirname(opts.outPath), { recursive: true });

  // Audio is muxed on *after* the (silent) video render, with Remotion's bundled
  // ffmpeg. When audio is wanted and ffmpeg resolves, render to a temp file and
  // mux into outPath; otherwise render straight to outPath (silent — unchanged).
  const audioOpts: AudioOptions = opts.audio ?? {};
  const ffmpeg = resolveBundledFfmpeg();
  const audioOn = wantsAudio(audioOpts) && ffmpeg !== null;
  const videoTarget = audioOn ? `${opts.outPath}.silent.mp4` : opts.outPath;

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: videoTarget,
    inputProps,
    browserExecutable,
    onProgress: opts.onProgress ? ({ progress }) => opts.onProgress!(progress) : undefined,
  });

  if (audioOn && ffmpeg) {
    const audioDir = await mkdtemp(join(tmpdir(), "demopilot-audio-"));
    try {
      const { wavPath } = await buildAudioTrack(opts.timeline, audioOpts, ffmpeg, audioDir);
      if (wavPath) {
        await muxAudio(videoTarget, wavPath, opts.outPath, ffmpeg);
        await rm(videoTarget, { force: true });
      } else {
        await rename(videoTarget, opts.outPath); // nothing audible — keep the video
      }
    } catch (err) {
      // Audio is a finishing touch — never let it fail the whole render. Fall back
      // to the silent video at outPath.
      console.error(`[demopilot] audio muxing failed (${(err as Error).message}); rendering without audio`);
      await rename(videoTarget, opts.outPath).catch(() => {});
    } finally {
      await rm(audioDir, { recursive: true, force: true });
    }
  }

  return {
    outPath: opts.outPath,
    width: composition.width,
    height: composition.height,
    fps,
    durationMs: opts.timeline.durationMs,
  };
}
