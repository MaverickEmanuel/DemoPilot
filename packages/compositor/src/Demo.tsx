import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { CameraMotionBlur, Trail } from "@remotion/motion-blur";
import type { CameraTrack } from "./camera";
import type { DemoCompositionProps, Timeline } from "./types";
import { cursorAt, clickPulseAt, captionAt, contentStartMs } from "./interp";
import { computeCameraTrack, cameraAt, cameraTransform, cameraSpeedAt, type CameraTransform } from "./camera";
import { Cursor } from "./Cursor";
import { FRAME, CANVAS, meshBackgroundAt, cardLayout } from "./frame";

/** Matches the seed app's dark background so the intro reveal is seamless. */
const STAGE_BG = "#0a0e1a";

// --- Synthetic motion blur tuning (content-agnostic; tuned by eye at 60 fps) ---
// Camera blur: map per-frame camera speed (card-space px/frame) to a small blur.
const CAM_BLUR_GAIN = 0.05;
const CAM_BLUR_MAX = 7;
// Cursor trail: ghosts along the recent path, faded by 0.5^n, gated by speed so
// slow/precise moves stay crisp. Speed is in video px/s.
const TRAIL_LAYERS = 4;
const TRAIL_SPEED_LO = 1200;
const TRAIL_SPEED_HI = 2000;
// Sampled (high-quality) mode: re-renders children at sub-frame offsets, so
// render cost ≈ SAMPLED_SAMPLES× the synthetic path. Opt-in only.
const SAMPLED_SHUTTER = 180;
const SAMPLED_SAMPLES = 8;

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
      trail={syntheticBlur}
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
  const blurPx =
    syntheticBlur && zoomOnClick
      ? clamp(cameraSpeedAt(track, tMs, vw, vh) * CAM_BLUR_GAIN, 0, CAM_BLUR_MAX)
      : 0;
  return { tMs, fps, view, blurPx };
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
 * of fading ghosts sampled along the recent Catmull-Rom path. */
const CursorLayer: React.FC<LayerProps & { trail: boolean }> = ({
  timeline,
  track,
  zoomOnClick,
  vw,
  vh,
  syntheticBlur,
  trail,
}) => {
  const { tMs, fps, view, blurPx } = useCameraView({ track, zoomOnClick, vw, vh, syntheticBlur });
  const frameMs = 1000 / fps;
  const cursor = cursorAt(timeline.cursor, tMs);
  const pulse = clickPulseAt(timeline, tMs);

  let ghosts: React.ReactNode = null;
  if (trail) {
    const prev = cursorAt(timeline.cursor, Math.max(0, tMs - frameMs));
    const speed = Math.hypot(cursor.x - prev.x, cursor.y - prev.y) / (frameMs / 1000); // px/s
    const gate = clamp01((speed - TRAIL_SPEED_LO) / (TRAIL_SPEED_HI - TRAIL_SPEED_LO));
    if (gate > 0) {
      ghosts = Array.from({ length: TRAIL_LAYERS }, (_, i) => {
        const n = i + 1;
        const p = cursorAt(timeline.cursor, Math.max(0, tMs - n * frameMs));
        return (
          <Cursor key={n} x={p.x} y={p.y} scale={track.cursorScale} opacity={Math.pow(0.5, n) * gate} />
        );
      });
    }
  }

  return (
    <div style={{ ...camGroupStyle(view, vw, vh), pointerEvents: "none", filter: blurFilter(blurPx) }}>
      {ghosts}
      <Cursor
        x={cursor.x}
        y={cursor.y}
        scale={track.cursorScale}
        pressing={pulse !== null && pulse.progress < 0.32}
      />
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
