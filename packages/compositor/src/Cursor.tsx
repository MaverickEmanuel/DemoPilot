import React from "react";

/** A macOS-style arrow cursor drawn as an SVG, positioned at (x, y). `scale`
 * enlarges the glyph for visibility (the press dip is layered on top). `opacity`
 * is used to fade synthetic motion-trail ghosts. */
export const Cursor: React.FC<{
  x: number;
  y: number;
  pressing?: boolean;
  scale?: number;
  opacity?: number;
}> = ({ x, y, pressing, scale = 1, opacity = 1 }) => {
  // A small dip on press reads as a click without distracting from the motion.
  const press = (pressing ? 0.86 : 1) * scale;
  return (
    <svg
      width={28}
      height={28}
      viewBox="0 0 28 28"
      style={{
        position: "absolute",
        left: x,
        top: y,
        // The hotspot is the tip of the arrow (top-left of the glyph); keep it
        // fixed while the glyph scales on press / for visibility.
        transform: `translate(-2px, -2px) scale(${press})`,
        transformOrigin: "2px 2px",
        filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.35))",
        opacity,
        pointerEvents: "none",
      }}
    >
      <path
        d="M5 3 L5 21 L10 16 L13.5 23 L16.5 21.5 L13 14.5 L20 14.5 Z"
        fill="#ffffff"
        stroke="#1c1c1c"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  );
};
