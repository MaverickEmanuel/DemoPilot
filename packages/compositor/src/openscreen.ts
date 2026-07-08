// ----------------------------------------------------------------------------
// OpenScreen export — turn a DemoPilot recording into an *editable* OpenScreen
// project instead of a flat MP4.
//
// DemoPilot and OpenScreen (https://github.com/getopenscreen/openscreen) share
// the same decomposition: a flat, cursor-less screen recording + a cursor path
// sampled over time + zoom "regions" placed over the timeline. renderDemo bakes
// that decomposition into a finished video; this module serializes it into
// OpenScreen's own on-disk project so the user can reopen it and hand-tune the
// zooms DemoPilot suggested, exactly as if they had recorded and placed them by
// hand.
//
// An OpenScreen "recording" on disk is three co-located files:
//
//   <name>.<ext>              the flat screen video (mp4 | webm | mov)
//   <name>.<ext>.cursor.json  cursor telemetry (samples + click markers)
//   <name>.openscreen         the project JSON (zoom + caption tracks, settings)
//
// On open, OpenScreen trusts any screenVideoPath inside the project file's own
// directory, so co-locating the three files is all that's required — no changes
// to OpenScreen's code.
//
// FORMAT PINNED TO OpenScreen PROJECT_VERSION 2 (getopenscreen/openscreen@b67811f):
//   src/components/video-editor/types.ts               ZoomRegion, AnnotationRegion, ZOOM_DEPTH_SCALES
//   src/components/video-editor/projectPersistence.ts  EditorProjectData, PROJECT_VERSION, normalizeProjectEditor
//   src/lib/recordingSession.ts                        ProjectMedia, cursorCaptureMode
//   electron/ipc/handlers.ts                           ${videoPath}.cursor.json sidecar (CURSOR_TELEMETRY_VERSION = 2)
//
// The `openscreen-format` test runs OpenScreen's *own* validateProjectData /
// normalizeProjectEditor against this module's output, so a format drift in a
// newer OpenScreen surfaces as a failing test rather than a silent bad export.
//
// Fidelity note: OpenScreen's persistence normalizer keeps a zoom region's
// discrete `depth` but drops any continuous `customScale`, so DemoPilot's exact
// per-shot magnification is snapped to the nearest of OpenScreen's six depth
// presets on reopen. We therefore emit `depth` (the value that round-trips) AND
// `customScale` (harmless today; exact if a build preserves it). The region's
// timing and focus point are exact either way.
// ----------------------------------------------------------------------------

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { Timeline, TimelineEvent, CursorSample } from "./types.js";
import { buildMotionPlan } from "./motionPlan.js";
import { probeVideoDimensions } from "./ffmpeg.js";

// --- OpenScreen on-disk shapes (structural mirrors of the pinned source) ------

export type OsZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

/** ZOOM_DEPTH_SCALES from OpenScreen types.ts — depth preset -> magnification. */
export const OS_ZOOM_DEPTH_SCALES: Record<OsZoomDepth, number> = {
  1: 1.25,
  2: 1.5,
  3: 1.8,
  4: 2.2,
  5: 3.5,
  6: 5.0,
};

export interface OsZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  depth: OsZoomDepth;
  focus: { cx: number; cy: number };
  focusMode: "manual" | "auto";
  source: "manual" | "auto";
  /** Exact magnification; ignored by the current persistence normalizer (see note). */
  customScale?: number;
}

export interface OsAnnotationRegion {
  id: string;
  startMs: number;
  endMs: number;
  type: "text";
  content: string;
  textContent: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  style: {
    color: string;
    backgroundColor: string;
    fontSize: number;
    fontFamily: string;
    fontWeight: "normal" | "bold";
    fontStyle: "normal" | "italic";
    textDecoration: "none" | "underline";
    textAlign: "left" | "center" | "right";
    textAnimation: "none";
  };
  zIndex: number;
}

/** Partial editor state — OpenScreen's normalizeProjectEditor fills every other
 * field with its documented default on load, so we set only what we mean. */
export interface OsEditorState {
  zoomRegions: OsZoomRegion[];
  annotationRegions: OsAnnotationRegion[];
  /** Off so OpenScreen never recomputes its own auto-zoom over ours. */
  autoZoomEnabled: false;
  autoFocusAll: false;
  aspectRatio: "native";
  cursorTheme: "default";
}

export interface OsProjectMedia {
  screenVideoPath: string;
  /** Render the cursor from telemetry (editable/re-themeable) rather than baked. */
  cursorCaptureMode: "editable-overlay";
}

export interface OsProject {
  version: 2;
  media: OsProjectMedia;
  editor: OsEditorState;
}

export interface OsCursorSample {
  timeMs: number;
  cx: number;
  cy: number;
  interactionType: "move" | "click" | "mouseup";
  visible: boolean;
  cursorType: string | null;
  assetId: string | null;
}

export interface OsCursorTelemetry {
  version: 2;
  provider: "none";
  samples: OsCursorSample[];
  assets: never[];
}

// OpenScreen DEFAULT_ANNOTATION_STYLE (types.ts) — inlined so the file is valid
// even for tooling that reads it without running normalizeProjectEditor.
const OS_DEFAULT_ANNOTATION_STYLE: OsAnnotationRegion["style"] = {
  color: "#ffffff",
  backgroundColor: "transparent",
  fontSize: 32,
  fontFamily: "Inter",
  fontWeight: "bold",
  fontStyle: "normal",
  textDecoration: "none",
  textAlign: "center",
  textAnimation: "none",
};

// --- conversion --------------------------------------------------------------

export interface BuildOpenScreenProjectOptions {
  /** Absolute path OpenScreen stores as media.screenVideoPath (the co-located video). */
  screenVideoPath: string;
  /** fps for motion-plan geometry (plan is fps-independent; kept for symmetry). */
  fps?: number;
}

export interface OpenScreenProjectBundle {
  project: OsProject;
  cursor: OsCursorTelemetry;
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const clamp01 = (x: number): number => clamp(x, 0, 1);
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The depth preset whose magnification is closest to a continuous zoom level. */
export function nearestDepth(level: number): OsZoomDepth {
  const depths = [1, 2, 3, 4, 5, 6] as const;
  let best: OsZoomDepth = 3;
  let bestErr = Number.POSITIVE_INFINITY;
  for (const d of depths) {
    const err = Math.abs(OS_ZOOM_DEPTH_SCALES[d] - level);
    if (err < bestErr) {
      bestErr = err;
      best = d;
    }
  }
  return best;
}

/** Estimate a caption's on-screen window from its text and the next caption. */
function captionEndMs(
  text: string,
  startMs: number,
  nextStartMs: number | null,
  durationMs: number,
): number {
  const estimate = clamp(text.length * 55, 1500, 7000); // ~55ms per character
  let end = startMs + estimate;
  if (nextStartMs != null) end = Math.min(end, nextStartMs - 50);
  end = Math.min(end, durationMs);
  return Math.max(startMs + 500, end);
}

/**
 * Build the OpenScreen project + cursor telemetry from a DemoPilot timeline.
 * Pure and deterministic: same timeline in, same JSON out.
 */
export function buildOpenScreenProject(
  timeline: Timeline,
  opts: BuildOpenScreenProjectOptions,
): OpenScreenProjectBundle {
  const vw = timeline.width;
  const vh = timeline.height;
  const durationMs = timeline.durationMs;
  const plan = buildMotionPlan(timeline, opts.fps ?? 60);

  // Shots -> zoom regions. A shot at ~1x is the un-zoomed establish framing, not
  // a zoom the user placed, so we drop it.
  const zoomRegions: OsZoomRegion[] = [];
  for (const shot of plan.shots) {
    if (shot.level <= 1.05) continue;
    const startMs = clamp(Math.round(shot.focusStart), 0, durationMs);
    const rawEnd = clamp(Math.round(shot.focusEnd), 0, durationMs);
    if (rawEnd <= startMs) continue;
    zoomRegions.push({
      id: `zoom-${zoomRegions.length + 1}`,
      startMs,
      endMs: Math.max(startMs + 1, rawEnd),
      depth: nearestDepth(shot.level),
      focus: { cx: clamp01(shot.anchor.x / vw), cy: clamp01(shot.anchor.y / vh) },
      focusMode: "manual",
      source: "manual",
      customScale: round2(clamp(shot.level, 1, 5)),
    });
  }

  // Narrate events -> text caption annotations (lower third).
  const narrations = timeline.events
    .filter((e: TimelineEvent): e is Extract<TimelineEvent, { kind: "narrate" }> => e.kind === "narrate")
    .sort((a, b) => a.t - b.t);
  const annotationRegions: OsAnnotationRegion[] = narrations.map((event, i) => {
    const startMs = Math.max(0, Math.round(event.t));
    const nextStartMs = i + 1 < narrations.length ? Math.round(narrations[i + 1].t) : null;
    return {
      id: `caption-${i + 1}`,
      startMs,
      endMs: Math.round(captionEndMs(event.text, startMs, nextStartMs, durationMs)),
      type: "text",
      content: event.text,
      textContent: event.text,
      position: { x: 50, y: 85 },
      size: { width: 80, height: 15 },
      style: { ...OS_DEFAULT_ANNOTATION_STYLE },
      zIndex: i + 1,
    };
  });

  // Cursor path -> telemetry samples, with clicks marked at their nearest sample.
  const samples: OsCursorSample[] = timeline.cursor.map((c: CursorSample) => ({
    timeMs: Math.max(0, Math.round(c.t)),
    cx: clamp01(c.x / vw),
    cy: clamp01(c.y / vh),
    interactionType: "move" as const,
    visible: true,
    cursorType: null,
    assetId: null,
  }));
  markClicks(samples, timeline, vw, vh);
  samples.sort((a, b) => a.timeMs - b.timeMs);

  const project: OsProject = {
    version: 2,
    media: {
      screenVideoPath: opts.screenVideoPath,
      cursorCaptureMode: "editable-overlay",
    },
    editor: {
      zoomRegions,
      annotationRegions,
      autoZoomEnabled: false,
      autoFocusAll: false,
      aspectRatio: "native",
      cursorTheme: "default",
    },
  };

  const cursor: OsCursorTelemetry = {
    version: 2,
    provider: "none",
    samples,
    assets: [],
  };

  return { project, cursor };
}

/** Stamp interactionType "click" on the sample nearest each click event; if the
 * nearest sample is far off (a gap in sampling), insert a synthetic click sample. */
function markClicks(samples: OsCursorSample[], timeline: Timeline, vw: number, vh: number): void {
  const CLICK_TOL_MS = 50;
  for (const event of timeline.events) {
    if (event.kind !== "click") continue;
    const t = Math.max(0, Math.round(event.t));
    let nearestIdx = -1;
    let nearestErr = Number.POSITIVE_INFINITY;
    for (let i = 0; i < samples.length; i++) {
      const err = Math.abs(samples[i].timeMs - t);
      if (err < nearestErr) {
        nearestErr = err;
        nearestIdx = i;
      }
    }
    if (nearestIdx >= 0 && nearestErr <= CLICK_TOL_MS) {
      samples[nearestIdx].interactionType = "click";
    } else {
      samples.push({
        timeMs: t,
        cx: clamp01(event.x / vw),
        cy: clamp01(event.y / vh),
        interactionType: "click",
        visible: true,
        cursorType: null,
        assetId: null,
      });
    }
  }
}

// --- writer ------------------------------------------------------------------

export interface WriteOpenScreenProjectOptions {
  /**
   * Path to the CLEAN screen recording — the raw capture from playDemo, mp4,
   * webm, or mov. This must NOT be renderDemo's finished/composited output:
   * that video has zoom, click ripples, and the padding background baked into
   * its pixels, which OpenScreen is meant to re-add as editable layers. The
   * clean capture's frame matches the timeline's coordinate space
   * (timeline.width x timeline.height); writeOpenScreenProject probes the video
   * and throws if it doesn't. See {@link assertCleanRecording}.
   */
  videoPath: string;
  /** The synchronized event timeline (sidecar of the recording). */
  timeline: Timeline;
  /** Directory the self-contained project bundle is written into. */
  outDir: string;
  /** Base name for the bundle files (default "demo"). */
  name?: string;
  fps?: number;
}

export interface WrittenOpenScreenProject {
  /** The .openscreen file to open in OpenScreen (File -> Open Project). */
  projectPath: string;
  /** The co-located screen video. */
  videoPath: string;
  /** The co-located cursor telemetry sidecar. */
  cursorPath: string;
  zoomRegionCount: number;
  annotationCount: number;
  cursorSampleCount: number;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "demo";

/**
 * Guards against importing a *composited* render into OpenScreen. The video
 * handed to OpenScreen MUST be the CLEAN screen recording — the raw capture
 * whose frame is the timeline's coordinate space. renderDemo's finished output
 * is a larger padded canvas with zoom, click ripples, and a background baked
 * into the pixels; importing that would double-apply the very things OpenScreen
 * is meant to re-add as editable layers. Dimensions are the reliable tell: the
 * clean capture is exactly timeline.width x timeline.height, the composite is a
 * different (padded) size. Throws on mismatch.
 */
export function assertCleanRecording(
  videoDimensions: { width: number; height: number },
  timeline: Timeline,
  videoName: string,
): void {
  if (videoDimensions.width === timeline.width && videoDimensions.height === timeline.height) return;
  throw new Error(
    `OpenScreen export needs the CLEAN screen recording (${timeline.width}x${timeline.height}, matching the ` +
      `timeline's coordinate space), but "${videoName}" is ${videoDimensions.width}x${videoDimensions.height}. ` +
      `This looks like renderDemo's composited output — a padded canvas with zoom, click ripples, and background ` +
      `already baked into the pixels. Import the clean capture instead (playDemo's raw recording); OpenScreen ` +
      `re-adds zoom, ripples, and padding as editable layers.`,
  );
}

/**
 * Writes a self-contained OpenScreen project folder from a DemoPilot recording:
 * copies the clean video in, writes the cursor telemetry sidecar, and writes the
 * .openscreen project referencing the co-located video by absolute path.
 */
export async function writeOpenScreenProject(
  opts: WriteOpenScreenProjectOptions,
): Promise<WrittenOpenScreenProject> {
  const name = slug(opts.name ?? "demo");
  const ext = extname(opts.videoPath).toLowerCase() || ".mp4";
  if (![".mp4", ".webm", ".mov"].includes(ext)) {
    throw new Error(`OpenScreen accepts .mp4, .webm, or .mov videos; got "${ext}" (${basename(opts.videoPath)})`);
  }

  // Backstop: refuse a composited render (padded canvas with zoom/ripples baked
  // in). The clean capture's dimensions equal the timeline's; the composite's
  // don't. Best-effort — if ffprobe is unavailable the probe returns null and we
  // proceed rather than block a valid export.
  const dims = probeVideoDimensions(opts.videoPath);
  if (dims) assertCleanRecording(dims, opts.timeline, basename(opts.videoPath));

  await mkdir(opts.outDir, { recursive: true });

  const videoOut = resolve(opts.outDir, `${name}${ext}`);
  const cursorOut = `${videoOut}.cursor.json`; // OpenScreen reads ${screenVideoPath}.cursor.json
  const projectOut = resolve(opts.outDir, `${name}.openscreen`);

  await copyFile(opts.videoPath, videoOut);

  const { project, cursor } = buildOpenScreenProject(opts.timeline, {
    screenVideoPath: videoOut,
    fps: opts.fps,
  });

  await writeFile(cursorOut, JSON.stringify(cursor, null, 2), "utf8");
  await writeFile(projectOut, JSON.stringify(project, null, 2), "utf8");

  return {
    projectPath: projectOut,
    videoPath: videoOut,
    cursorPath: cursorOut,
    zoomRegionCount: project.editor.zoomRegions.length,
    annotationCount: project.editor.annotationRegions.length,
    cursorSampleCount: cursor.samples.length,
  };
}
