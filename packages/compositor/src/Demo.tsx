import React from "react";
import { AbsoluteFill, Freeze, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { CameraMotionBlur, Trail } from "@remotion/motion-blur";
import type { CameraTrack } from "./camera";
import type { DemoCompositionProps, Timeline } from "./types";
import { plannedCursorAt, clickPulseAt, cursorPressAt, captionAt } from "./interp";
import { cameraAt, cameraTransform, cameraSpeedAt, type CameraTransform } from "./camera";
import { computeCameraMotion, OUTRO_FADE_MS, IDLE_FADE_MS, type MotionPlan } from "./motionPlan";
import { Cursor } from "./Cursor";
import { FRAME, CANVAS, meshBackgroundAt, cardLayout } from "./frame";

/** Matches the seed app's dark background so the intro reveal is seamless. */
const STAGE_BG = "#0a0e1a";

// --- Synthetic motion blur tuning (content-agnostic; tuned by eye at 60 fps) ---
// Camera blur: map per-frame camera speed (card-space px/frame) to a small blur.
// Kept deliberately light — strong blur smears text/UI during zooms and reads as
// low-quality. Just enough to take the edge off 60 fps transitions, no more.
const CAM_BLUR_GAIN = 0.04;
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
// Sampled (high-quality) mode: re-renders children at sub-frame offsets, so
// render cost ≈ SAMPLED_SAMPLES× the synthetic path. Opt-in only.
const SAMPLED_SHUTTER = 180;
const SAMPLED_SAMPLES = 8;

// Cursor renders in screen-space at a constant on-screen size (decoupled from the
// camera zoom). The SVG glyph box is 28px; on-screen canvas size ≈
// CURSOR_BASE_PX × cursorScale, independent of zoom and card layout.
const CURSOR_SVG_PX = 28;
// On-screen cursor size ≈ CURSOR_BASE_PX × cursorScale. Bumped from 24 → 28 so the
// pointer reads at a Screen-Studio-like legible size (~42px on the 1080 canvas)
// without ballooning at high zoom (it stays in screen space, decoupled from zoom).
const CURSOR_BASE_PX = 28;

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

  // The motion plan + spring camera track are computed once (the plan is the
  // shared source of truth for the cursor and the camera) and sampled per frame.
  const { track, plan } = React.useMemo(() => computeCameraMotion(timeline, fps), [timeline, fps]);

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
      plan={plan}
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
      plan={plan}
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
  plan: MotionPlan;
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
  plan,
  zoomOnClick,
  vw,
  vh,
  syntheticBlur,
}) => {
  const { tMs, fps, view, blurPx } = useCameraView({ track, zoomOnClick, vw, vh, syntheticBlur });
  const outDurationMs = plan.outputDurationMs;
  const pulse = clickPulseAt(timeline, tMs);

  // Hide the browser's blank startup page (a white flash) before the first paint,
  // then reveal the content with a short fade; gentle fade-out at the very end.
  const introCover = 1 - clamp01((tMs - (plan.contentStartMs + 100)) / 240);
  const outro = clamp01((tMs - (outDurationMs - OUTRO_FADE_MS)) / OUTRO_FADE_MS);

  // Past the recording the composition extends by the outro freeze-hold, so hold
  // the final recorded frame (the camera keeps easing to its landing framing).
  const lastVideoFrame = Math.max(0, Math.round((timeline.durationMs / 1000) * fps) - 1);

  return (
    <div style={{ ...camGroupStyle(view, vw, vh), filter: blurFilter(blurPx) }}>
      <Freeze frame={lastVideoFrame} active={tMs >= timeline.durationMs}>
        <OffthreadVideo src={staticFile(videoFile)} style={{ width: vw, height: vh, display: "block" }} />
      </Freeze>

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
  plan,
  zoomOnClick,
  vw,
  vh,
  syntheticBlur,
  layoutScale,
}) => {
  const { tMs, fps, view, blurPx } = useCameraView({ track, zoomOnClick, vw, vh, syntheticBlur });
  const frameMs = 1000 / fps;
  const cursor = plannedCursorAt(plan, timeline.cursor, tMs);
  const press = cursorPressAt(timeline, tMs);

  // The cursor smears less than the content, so cap its blur tighter. It blurs
  // both when the camera moves and when the cursor itself flicks fast — a smooth
  // motion smear in place of a ghost trail. Under the follow-cam this rarely
  // triggers (travels are speed-capped), which is by design.
  const prevCursor = plannedCursorAt(plan, timeline.cursor, Math.max(0, tMs - frameMs));
  const cursorSpeed = Math.hypot(cursor.x - prevCursor.x, cursor.y - prevCursor.y) / (frameMs / 1000); // px/s
  const smear = syntheticBlur
    ? clamp01((cursorSpeed - CURSOR_SMEAR_SPEED_LO) / (CURSOR_SMEAR_SPEED_HI - CURSOR_SMEAR_SPEED_LO)) * CURSOR_BLUR_MAX
    : 0;
  const cursorBlur = Math.min(CURSOR_BLUR_MAX, Math.max(blurPx, smear));
  // Visibility = the content gate (hidden until the first content reveals) × the
  // idle fade (fades out after prolonged stillness, back in before the next
  // travel departs). The camera-speed fade is gone — the follow-cam makes it
  // obsolete (the cursor no longer whips against a fast pan).
  const contentGate = clamp01((tMs - (plan.contentStartMs + 100)) / 200);
  const cursorOpacity = contentGate * idleFadeOpacity(plan.idleFades, tMs);

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

/** Smooth Hermite ramp; 0 at a, 1 at b (works for a>b too). */
function smoothstep01(a: number, b: number, x: number): number {
  if (a === b) return x >= a ? 1 : 0;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** The idle-fade opacity at `tMs`: 1 normally, dipping toward 0 during each
 * precomputed idle window (fade out after stillness, fade back in before the
 * next travel departs). `fadeInAt` may be Infinity (the final hold never returns). */
function idleFadeOpacity(fades: MotionPlan["idleFades"], tMs: number): number {
  let op = 1;
  for (const f of fades) {
    if (tMs <= f.fadeOutAt || tMs >= f.fadeInAt) continue;
    const down = 1 - smoothstep01(f.fadeOutAt, f.fadeOutAt + IDLE_FADE_MS, tMs); // 1 → 0
    const up = smoothstep01(f.fadeInAt - IDLE_FADE_MS, f.fadeInAt, tMs); // 0 → 1
    op = Math.min(op, Math.max(down, up));
  }
  return op;
}

/** Ease-out cubic, for the ripple expansion. */
function easeOut(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}
