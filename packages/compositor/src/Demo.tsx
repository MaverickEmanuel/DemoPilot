import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { CameraMotionBlur, Trail } from "@remotion/motion-blur";
import type { CameraTrack } from "./camera";
import type { DemoCompositionProps, Timeline } from "./types";
import { cursorAt, clickPulseAt, cursorPressAt, captionAt, contentStartMs } from "./interp";
import { computeCameraTrack, cameraAt, cameraTransform, cameraSpeedAt, type CameraTransform } from "./camera";
import { Cursor } from "./Cursor";
import { FRAME, CANVAS, meshBackgroundAt, cardLayout } from "./frame";

/** Matches the seed app's dark background so the intro reveal is seamless. */
const STAGE_BG = "#0a0e1a";

// --- Synthetic motion blur tuning (content-agnostic; tuned by eye at 60 fps) ---
// Camera blur: map per-frame camera speed (card-space px/frame) to a small blur.
// Kept deliberately light — strong blur smears text/UI during zooms and reads as
// low-quality. Just enough to take the edge off 60 fps transitions, no more.
const CAM_BLUR_GAIN = 0.03;
const CAM_BLUR_MAX = 4;
// The cursor smears more readily than the UI (it's small and high-contrast), so
// cap its blur tighter than the content's — a crisp pointer reads as intentional.
const CURSOR_BLUR_MAX = 2;
// Fast cursor flicks get a smooth motion blur rather than a discrete ghost trail:
// stacked ghost copies read as stray "loading dots" (especially when the camera's
// spring momentarily stalls right as the cursor whips past), whereas a continuous
// smear always reads as motion. Gated by cursor speed (video px/s) so slow,
// precise moves stay crisp. (The opt-in "sampled" mode still uses a real <Trail>.)
const TRAIL_LAYERS = 3; // sampled-mode <Trail> only
const CURSOR_SMEAR_SPEED_LO = 1500;
const CURSOR_SMEAR_SPEED_HI = 2800;
// During a fast camera move the cursor is just travelling to the next target, so
// fade it down to keep attention on the product (it fades back in as the camera
// settles on the action). Driven by camera speed (card-space px/frame).
const CURSOR_FADE_SPEED_LO = 8;
const CURSOR_FADE_SPEED_HI = 34;
const CURSOR_FADE_MIN = 0.45;
// Sampled (high-quality) mode: re-renders children at sub-frame offsets, so
// render cost ≈ SAMPLED_SAMPLES× the synthetic path. Opt-in only.
const SAMPLED_SHUTTER = 180;
const SAMPLED_SAMPLES = 8;

// Cursor renders in screen-space at a constant on-screen size (decoupled from the
// camera zoom). The SVG glyph box is 28px; on-screen canvas size ≈
// CURSOR_BASE_PX × cursorScale, independent of zoom and card layout.
const CURSOR_SVG_PX = 28;
const CURSOR_BASE_PX = 24;

/**
 * Composites the clean recording with a redrawn cursor, click ripples, the
 * spring-physics tracking camera, and optional captions — presented inside a
 * composed "app card" (background, inset, rounded corners, soft shadow) on a
 * fixed 16:9 1080p canvas.
 *
 * Coordinate correctness: every overlay coordinate (cursor, ripple, camera
 * focus) is in VIDEO pixel space. The video and the cursor each live in a group
 * sized to the video and carrying the *same* camera transform, so they stay
 * pixel-aligned. The card itself is scaled/positioned by a single wrapper, and
 * the camera transform lives *inside* it — so the inset/corners/shadow stay put
 * while the app content zooms and pans.
 *
 * Motion blur: the camera-driven content (video + cursor) is rendered by
 * frame-reading layers so that "sampled" mode can re-render them at sub-frame
 * offsets via @remotion/motion-blur. "synthetic" (default) instead derives a
 * cheap per-frame blur from the keyframe track and a hand-rolled cursor trail.
 */
export const Demo: React.FC<DemoCompositionProps> = ({
  videoFile,
  timeline,
  zoomOnClick,
  captions,
  framed = true,
  background,
  backgroundDrift = false,
  motionBlur = "synthetic",
  vignette = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tMs = (frame / fps) * 1000;

  const vw = timeline.width;
  const vh = timeline.height;
  const radius = framed ? FRAME.radius : 0;

  // The spring camera track is simulated once and sampled per frame.
  const track = React.useMemo(() => computeCameraTrack(timeline, fps), [timeline, fps]);

  const caption = captions ? captionAt(timeline, tMs) : null;

  // Card placement: fit the recording into the padded canvas (framed) or fill it.
  const canvasW = framed ? CANVAS.width : vw;
  const canvasH = framed ? CANVAS.height : vh;
  const layout = framed ? cardLayout(canvasW, canvasH, vw, vh) : { scale: 1, left: 0, top: 0 };

  const sampled = motionBlur === "sampled";
  const syntheticBlur = motionBlur === "synthetic";

  const videoLayer = (
    <VideoLayer
      videoFile={videoFile}
      timeline={timeline}
      track={track}
      zoomOnClick={zoomOnClick}
      vw={vw}
      vh={vh}
      syntheticBlur={syntheticBlur}
    />
  );
  const cursorLayer = (
    <CursorLayer
      timeline={timeline}
      track={track}
      zoomOnClick={zoomOnClick}
      vw={vw}
      vh={vh}
      syntheticBlur={syntheticBlur}
      layoutScale={layout.scale}
    />
  );

  return (
    <AbsoluteFill
      style={{ background: framed ? meshBackgroundAt(background, tMs / 1000, backgroundDrift) : STAGE_BG }}
    >
      {/* Card wrapper: scales the video-space card into the canvas and centers it.
          Everything inside works in video pixels. */}
      <div
        style={{
          position: "absolute",
          left: layout.left,
          top: layout.top,
          width: vw,
          height: vh,
          transform: `scale(${layout.scale})`,
          transformOrigin: "top left",
        }}
      >
        {/* The app card: fixed in card space (does not move with the camera), so the
            corners and shadow stay put while the content zooms/pans inside. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: radius,
            boxShadow: framed ? FRAME.shadow : "none",
          }}
        >
          {/* Rounded clip: rounds the video's corners. The camera lives inside it. */}
          <div style={{ position: "absolute", inset: 0, borderRadius: radius, overflow: "hidden" }}>
            {sampled ? (
              <CameraMotionBlur shutterAngle={SAMPLED_SHUTTER} samples={SAMPLED_SAMPLES}>
                {videoLayer}
              </CameraMotionBlur>
            ) : (
              videoLayer
            )}
          </div>

          {/* Cursor: same camera transform, but outside the rounded clip so its tip
              is never clipped by the corner radius. */}
          {sampled ? (
            <Trail layers={TRAIL_LAYERS} lagInFrames={1} trailOpacity={0.5}>
              {cursorLayer}
            </Trail>
          ) : (
            cursorLayer
          )}
        </div>
      </div>

      {/* A subtle edge vignette adds depth — darkens the canvas corners slightly,
          below the captions so text stays crisp. */}
      {vignette && (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: "radial-gradient(125% 125% at 50% 50%, transparent 58%, rgba(0,0,0,0.16) 100%)",
          }}
        />
      )}

      {caption && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: FRAME.pad - 8,
            display: "flex",
            justifyContent: "center",
            opacity: caption.opacity,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              maxWidth: "80%",
              padding: "12px 22px",
              borderRadius: 12,
              background: "rgba(12,16,32,0.82)",
              color: "#f2f5ff",
              font: "500 26px/1.3 ui-sans-serif, system-ui, sans-serif",
              boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
              backdropFilter: "blur(2px)",
            }}
          >
            {caption.text}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

/** The camera transform as a style for a video-sized group (transform-origin 0 0
 * so the translate/scale math in `cameraTransform` holds). */
function camGroupStyle(view: CameraTransform, vw: number, vh: number): React.CSSProperties {
  return {
    position: "absolute",
    width: vw,
    height: vh,
    transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`,
    transformOrigin: "0 0",
  };
}

interface LayerProps {
  timeline: Timeline;
  track: CameraTrack;
  zoomOnClick: boolean;
  vw: number;
  vh: number;
  syntheticBlur: boolean;
}

/** Per-frame camera-driven view + synthetic camera blur (0 when not applicable). */
function useCameraView(props: Pick<LayerProps, "track" | "zoomOnClick" | "vw" | "vh" | "syntheticBlur">) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  const { track, zoomOnClick, vw, vh, syntheticBlur } = props;
  const cam = zoomOnClick ? cameraAt(track, tMs) : { scale: 1, focusX: vw / 2, focusY: vh / 2 };
  const view = cameraTransform(cam, vw, vh);
  // Only the real camera produces motion; with zoom off the view is the identity.
  const camSpeed = syntheticBlur && zoomOnClick ? cameraSpeedAt(track, tMs, vw, vh) : 0;
  const blurPx = clamp(camSpeed * CAM_BLUR_GAIN, 0, CAM_BLUR_MAX);
  return { tMs, fps, view, blurPx, camSpeed };
}

const blurFilter = (px: number): string | undefined => (px > 0.05 ? `blur(${px}px)` : undefined);

/** The video group: the recording, the click ripple, and the intro/outro covers,
 * all under the camera transform (and an optional synthetic camera blur). */
const VideoLayer: React.FC<LayerProps & { videoFile: string }> = ({
  videoFile,
  timeline,
  track,
  zoomOnClick,
  vw,
  vh,
  syntheticBlur,
}) => {
  const { tMs, fps, view, blurPx } = useCameraView({ track, zoomOnClick, vw, vh, syntheticBlur });
  const { durationInFrames } = useVideoConfig();
  const durationMs = (durationInFrames / fps) * 1000;
  const pulse = clickPulseAt(timeline, tMs);

  // Hide the browser's blank startup page (a white flash) before the first paint,
  // then reveal the content with a short fade; gentle fade-out at the very end.
  const contentStart = contentStartMs(timeline);
  const introCover = 1 - clamp01((tMs - (contentStart + 100)) / 240);
  const outro = clamp01((tMs - (durationMs - 300)) / 300);

  return (
    <div style={{ ...camGroupStyle(view, vw, vh), filter: blurFilter(blurPx) }}>
      <OffthreadVideo src={staticFile(videoFile)} style={{ width: vw, height: vh, display: "block" }} />

      {pulse && <Ripple x={pulse.x} y={pulse.y} progress={pulse.progress} />}

      {introCover > 0 && (
        <div style={{ position: "absolute", inset: 0, backgroundColor: STAGE_BG, opacity: introCover }} />
      )}
      {outro > 0 && (
        <div style={{ position: "absolute", inset: 0, backgroundColor: STAGE_BG, opacity: outro }} />
      )}
    </div>
  );
};

/** The cursor group: the live cursor plus, in synthetic mode, a speed-gated trail
 * of fading ghosts sampled along the recent Catmull-Rom path.
 *
 * The cursor lives in SCREEN space — only its position is taken through the camera
 * (so it tracks the focused element), while the glyph stays a constant on-screen
 * size regardless of zoom. This matches premium tools (Screen Studio/Cap), where
 * the pointer never balloons at high zoom. */
const CursorLayer: React.FC<LayerProps & { layoutScale: number }> = ({
  timeline,
  track,
  zoomOnClick,
  vw,
  vh,
  syntheticBlur,
  layoutScale,
}) => {
  const { tMs, fps, view, blurPx, camSpeed } = useCameraView({ track, zoomOnClick, vw, vh, syntheticBlur });
  const frameMs = 1000 / fps;
  const cursor = cursorAt(timeline.cursor, tMs);
  const press = cursorPressAt(timeline, tMs);

  // The cursor smears less than the content, so cap its blur tighter. It blurs
  // both when the camera moves and when the cursor itself flicks fast — a smooth
  // motion smear in place of a ghost trail. And it fades while the camera is
  // travelling (it's relocating, not acting) so it doesn't pull focus mid-pan.
  const prevCursor = cursorAt(timeline.cursor, Math.max(0, tMs - frameMs));
  const cursorSpeed = Math.hypot(cursor.x - prevCursor.x, cursor.y - prevCursor.y) / (frameMs / 1000); // px/s
  const smear = syntheticBlur
    ? clamp01((cursorSpeed - CURSOR_SMEAR_SPEED_LO) / (CURSOR_SMEAR_SPEED_HI - CURSOR_SMEAR_SPEED_LO)) * CURSOR_BLUR_MAX
    : 0;
  const cursorBlur = Math.min(CURSOR_BLUR_MAX, Math.max(blurPx, smear));
  const cursorOpacity =
    1 - (1 - CURSOR_FADE_MIN) * clamp01((camSpeed - CURSOR_FADE_SPEED_LO) / (CURSOR_FADE_SPEED_HI - CURSOR_FADE_SPEED_LO));

  // Project a video-space point to screen (card) space through the camera.
  const project = (x: number, y: number) => ({ x: view.tx + x * view.scale, y: view.ty + y * view.scale });
  // Constant on-screen size: undo the card layout scale so canvas px is fixed.
  const glyphScale = (CURSOR_BASE_PX * track.cursorScale) / (CURSOR_SVG_PX * layoutScale);

  const c = project(cursor.x, cursor.y);
  return (
    <div
      style={{
        position: "absolute",
        width: vw,
        height: vh,
        pointerEvents: "none",
        opacity: cursorOpacity,
        filter: blurFilter(cursorBlur),
      }}
    >
      <Cursor x={c.x} y={c.y} scale={glyphScale} press={press} />
    </div>
  );
};

/** A subtle, springy click ripple — a soft filled disc plus a thin expanding ring. */
const Ripple: React.FC<{ x: number; y: number; progress: number }> = ({ x, y, progress }) => {
  const out = easeOut(progress);
  const ringScale = 1 + out * 2.6;
  const ringOpacity = (1 - progress) * (1 - progress) * 0.9;
  // A brief inner flash on the press that fades faster than the ring.
  const flashOpacity = (1 - clamp01(progress / 0.45)) * 0.5;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: 22,
          height: 22,
          marginLeft: -11,
          marginTop: -11,
          borderRadius: "50%",
          background: "rgba(124,109,255,0.55)",
          transform: `scale(${0.7 + out * 0.6})`,
          opacity: flashOpacity,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: x,
          top: y,
          width: 22,
          height: 22,
          marginLeft: -11,
          marginTop: -11,
          borderRadius: "50%",
          border: "2px solid rgba(140,126,255,0.95)",
          boxShadow: "0 0 14px rgba(124,109,255,0.5)",
          transform: `scale(${ringScale})`,
          opacity: ringOpacity,
          pointerEvents: "none",
        }}
      />
    </>
  );
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Ease-out cubic, for the ripple expansion. */
function easeOut(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}
