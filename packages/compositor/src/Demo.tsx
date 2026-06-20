import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { DemoCompositionProps } from "./types";
import { cursorAt, clickPulseAt, zoomAt, captionAt, contentStartMs } from "./interp";
import { Cursor } from "./Cursor";

/** Matches the seed app's dark background so the intro reveal is seamless. */
const STAGE_BG = "#0a0e1a";

/**
 * Composites the clean recording with a redrawn cursor, click ripples, an
 * optional subtle zoom-toward-cursor, and optional captions.
 */
export const Demo: React.FC<DemoCompositionProps> = ({ videoFile, timeline, zoomOnClick, captions }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const tMs = (frame / fps) * 1000;
  const durationMs = (durationInFrames / fps) * 1000;

  const cursor = cursorAt(timeline.cursor, tMs);
  const pulse = clickPulseAt(timeline, tMs);
  const zoom = zoomOnClick
    ? zoomAt(timeline, tMs)
    : { scale: 1, originX: timeline.width / 2, originY: timeline.height / 2 };
  const caption = captions ? captionAt(timeline, tMs) : null;

  // Hide the browser's blank startup page (a white flash) before the first
  // paint, then reveal the content with a short fade.
  const contentStart = contentStartMs(timeline);
  const introCover = 1 - clamp01((tMs - (contentStart + 100)) / 240);
  // Gentle fade-out at the very end.
  const outro = clamp01((tMs - (durationMs - 300)) / 300);

  return (
    <AbsoluteFill style={{ backgroundColor: STAGE_BG }}>
      <AbsoluteFill
        style={{
          transform: `scale(${zoom.scale})`,
          transformOrigin: `${zoom.originX}px ${zoom.originY}px`,
        }}
      >
        <OffthreadVideo src={staticFile(videoFile)} />

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

        <Cursor x={cursor.x} y={cursor.y} pressing={pulse !== null && pulse.progress < 0.32} />
      </AbsoluteFill>

      {caption && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 48,
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

      {introCover > 0 && (
        <AbsoluteFill style={{ backgroundColor: STAGE_BG, opacity: introCover, pointerEvents: "none" }} />
      )}
      {outro > 0 && (
        <AbsoluteFill style={{ backgroundColor: STAGE_BG, opacity: outro, pointerEvents: "none" }} />
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
