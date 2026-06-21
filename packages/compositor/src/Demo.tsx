import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { DemoCompositionProps } from "./types";
import { cursorAt, clickPulseAt, captionAt, contentStartMs } from "./interp";
import { computeCameraTrack, cameraAt } from "./camera";
import { Cursor } from "./Cursor";
import { FRAME, CANVAS, backgroundFor, cardLayout } from "./frame";

/** Matches the seed app's dark background so the intro reveal is seamless. */
const STAGE_BG = "#0a0e1a";

/**
 * Composites the clean recording with a redrawn cursor, click ripples, the
 * spring-physics tracking camera, and optional captions — presented inside a
 * composed "app card" (background, inset, rounded corners, soft shadow) on a
 * fixed 16:9 1080p canvas.
 *
 * Coordinate correctness: every overlay coordinate (cursor, ripple, camera
 * origin) is in VIDEO pixel space. The video and the cursor each live in a group
 * sized to the video and carrying the *same* camera transform, so they stay
 * pixel-aligned. The card itself is scaled/positioned by a single wrapper, and
 * the camera transform lives *inside* it — so the inset/corners/shadow stay put
 * while the app content zooms and pans.
 */
export const Demo: React.FC<DemoCompositionProps> = ({
  videoFile,
  timeline,
  zoomOnClick,
  captions,
  framed = true,
  background,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  const durationMs = (durationInFrames / fps) * 1000;

  const vw = timeline.width;
  const vh = timeline.height;
  const radius = framed ? FRAME.radius : 0;

  // The spring camera track is simulated once and sampled per frame.
  const track = React.useMemo(() => computeCameraTrack(timeline, fps), [timeline, fps]);

  const cursor = cursorAt(timeline.cursor, tMs);
  const pulse = clickPulseAt(timeline, tMs);
  const cam = zoomOnClick ? cameraAt(track, tMs) : { scale: 1, originX: vw / 2, originY: vh / 2 };
  const caption = captions ? captionAt(timeline, tMs) : null;

  // Card placement: fit the recording into the padded canvas (framed) or fill it.
  const canvasW = framed ? CANVAS.width : vw;
  const canvasH = framed ? CANVAS.height : vh;
  const layout = framed
    ? cardLayout(canvasW, canvasH, vw, vh)
    : { scale: 1, left: 0, top: 0 };

  // Hide the browser's blank startup page (a white flash) before the first
  // paint, then reveal the content with a short fade.
  const contentStart = contentStartMs(timeline);
  const introCover = 1 - clamp01((tMs - (contentStart + 100)) / 240);
  // Gentle fade-out at the very end.
  const outro = clamp01((tMs - (durationMs - 300)) / 300);

  // One camera transform, applied identically to the video group and the cursor
  // group (which is *outside* the rounded clip so the cursor tip is never cut).
  const camStyle: React.CSSProperties = {
    position: "absolute",
    width: vw,
    height: vh,
    transform: `scale(${cam.scale})`,
    transformOrigin: `${cam.originX}px ${cam.originY}px`,
  };

  return (
    <AbsoluteFill style={{ background: framed ? backgroundFor(background) : STAGE_BG }}>
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
            <div style={camStyle}>
              <OffthreadVideo src={staticFile(videoFile)} style={{ width: vw, height: vh, display: "block" }} />

              {pulse && <Ripple x={pulse.x} y={pulse.y} progress={pulse.progress} />}

              {/* Intro/outro covers sit over the video only, so the framed card and
                  its shadow stay visible during the reveal and fade. */}
              {introCover > 0 && (
                <div style={{ position: "absolute", inset: 0, backgroundColor: STAGE_BG, opacity: introCover }} />
              )}
              {outro > 0 && (
                <div style={{ position: "absolute", inset: 0, backgroundColor: STAGE_BG, opacity: outro }} />
              )}
            </div>
          </div>

          {/* Cursor: same camera transform, but outside the rounded clip so its tip
              is never clipped by the corner radius. */}
          <div style={{ ...camStyle, pointerEvents: "none" }}>
            <Cursor
              x={cursor.x}
              y={cursor.y}
              scale={track.cursorScale}
              pressing={pulse !== null && pulse.progress < 0.32}
            />
          </div>
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

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Ease-out cubic, for the ripple expansion. */
function easeOut(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}
