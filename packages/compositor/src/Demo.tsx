import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { DemoCompositionProps } from "./types";
import { cursorAt, clickPulseAt, zoomAt, captionAt, contentStartMs } from "./interp";
import { Cursor } from "./Cursor";
import { FRAME } from "./frame";

/** Matches the seed app's dark background so the intro reveal is seamless. */
const STAGE_BG = "#0a0e1a";

/**
 * Composites the clean recording with a redrawn cursor, click ripples, an
 * optional subtle zoom-toward-cursor, and optional captions — presented inside a
 * composed "app card" (background, inset, rounded corners, soft shadow).
 *
 * Coordinate correctness: every overlay coordinate (cursor, ripple, zoom origin)
 * is in VIDEO pixel space. The video and the cursor each live in a group sized to
 * the video and carrying the *same* zoom transform, so they stay pixel-aligned.
 * The card frame itself does NOT scale with the zoom — only the content inside it
 * does — so the inset/corners/shadow stay put while the app gently zooms.
 */
export const Demo: React.FC<DemoCompositionProps> = ({
  videoFile,
  timeline,
  zoomOnClick,
  captions,
  framed = true,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  const durationMs = (durationInFrames / fps) * 1000;

  const vw = timeline.width;
  const vh = timeline.height;
  const pad = framed ? FRAME.pad : 0;
  const radius = framed ? FRAME.radius : 0;

  const cursor = cursorAt(timeline.cursor, tMs);
  const pulse = clickPulseAt(timeline, tMs);
  const zoom = zoomOnClick
    ? zoomAt(timeline, tMs)
    : { scale: 1, originX: vw / 2, originY: vh / 2 };
  const caption = captions ? captionAt(timeline, tMs) : null;

  // Hide the browser's blank startup page (a white flash) before the first
  // paint, then reveal the content with a short fade.
  const contentStart = contentStartMs(timeline);
  const introCover = 1 - clamp01((tMs - (contentStart + 100)) / 240);
  // Gentle fade-out at the very end.
  const outro = clamp01((tMs - (durationMs - 300)) / 300);

  // One zoom transform, applied identically to the video group and the cursor
  // group (which is *outside* the rounded clip so the cursor tip is never cut).
  const zoomStyle: React.CSSProperties = {
    position: "absolute",
    width: vw,
    height: vh,
    transform: `scale(${zoom.scale})`,
    transformOrigin: `${zoom.originX}px ${zoom.originY}px`,
  };

  return (
    <AbsoluteFill style={{ background: framed ? FRAME.background : STAGE_BG }}>
      {/* The app card: fixed in screen space (does not scale with the zoom), so the
          inset, rounded corners and shadow stay put while the content zooms inside. */}
      <div
        style={{
          position: "absolute",
          left: pad,
          top: pad,
          width: vw,
          height: vh,
          borderRadius: radius,
          boxShadow: framed ? FRAME.shadow : "none",
        }}
      >
        {/* Rounded clip: rounds the video's corners. The zoom lives inside it. */}
        <div style={{ position: "absolute", inset: 0, borderRadius: radius, overflow: "hidden" }}>
          <div style={zoomStyle}>
            <OffthreadVideo src={staticFile(videoFile)} style={{ width: vw, height: vh, display: "block" }} />

            {pulse && (
              <div
                style={{
                  position: "absolute",
                  left: pulse.x,
                  top: pulse.y,
                  width: 20,
                  height: 20,
                  marginLeft: -10,
                  marginTop: -10,
                  borderRadius: "50%",
                  border: "2px solid rgba(124,109,255,0.9)",
                  boxShadow: "0 0 12px rgba(124,109,255,0.55)",
                  transform: `scale(${1 + ease3(pulse.progress) * 2.2})`,
                  opacity: (1 - pulse.progress) * (1 - pulse.progress),
                  pointerEvents: "none",
                }}
              />
            )}

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

        {/* Cursor: same zoom transform, but outside the rounded clip so its tip is
            never clipped by the corner radius. */}
        <div style={{ ...zoomStyle, pointerEvents: "none" }}>
          <Cursor x={cursor.x} y={cursor.y} pressing={pulse !== null && pulse.progress < 0.32} />
        </div>
      </div>

      {caption && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: pad + 28,
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

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Ease-out cubic, for the ripple expansion. */
function ease3(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}
