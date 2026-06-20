import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { DemoCompositionProps } from "./types";
import { cursorAt, clickPulseAt, zoomAt, captionAt } from "./interp";
import { Cursor } from "./Cursor";

/**
 * Composites the clean recording with a redrawn cursor, click ripples, an
 * optional subtle zoom-toward-cursor, and optional captions.
 */
export const Demo: React.FC<DemoCompositionProps> = ({ videoFile, timeline, zoomOnClick, captions }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tMs = (frame / fps) * 1000;

  const cursor = cursorAt(timeline.cursor, tMs);
  const pulse = clickPulseAt(timeline, tMs);
  const zoom = zoomOnClick ? zoomAt(timeline, tMs) : { scale: 1, originX: timeline.width / 2, originY: timeline.height / 2 };
  const caption = captions ? captionAt(timeline, tMs) : null;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
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
              width: 18,
              height: 18,
              marginLeft: -9,
              marginTop: -9,
              borderRadius: "50%",
              border: "2px solid rgba(109,94,252,0.9)",
              transform: `scale(${1 + pulse.progress * 2.4})`,
              opacity: 1 - pulse.progress,
              pointerEvents: "none",
            }}
          />
        )}

        <Cursor x={cursor.x} y={cursor.y} />
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
            }}
          >
            {caption}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};
