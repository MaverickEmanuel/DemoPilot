// A self-contained copy of the timeline shape consumed by the Remotion bundle.
// Kept independent of @demopilot/core so the browser bundler never has to
// resolve the Node-only core package. The shapes must stay structurally
// compatible with core's Timeline.

export interface CursorSample {
  t: number;
  x: number;
  y: number;
}

export type TimelineEvent =
  | { kind: "navigate"; t: number; url: string }
  | { kind: "click"; t: number; x: number; y: number; button: "left" | "right" | "middle" }
  | { kind: "type"; t: number; tStart: number; text: string }
  | { kind: "scroll"; t: number; x: number; y: number }
  | { kind: "narrate"; t: number; text: string }
  | { kind: "zoom"; t: number; action: "in" | "out" };

export interface ZoomConfig {
  /** Max magnification for activity zooms (1 = no zoom). */
  level: number;
}

export interface Timeline {
  version: 1;
  width: number;
  height: number;
  durationMs: number;
  cursor: CursorSample[];
  events: TimelineEvent[];
  zoom?: ZoomConfig;
}

export interface DemoCompositionProps {
  videoFile: string;
  timeline: Timeline;
  fps: number;
  /** Toggle the subtle zoom-toward-cursor on click. */
  zoomOnClick: boolean;
  /** Toggle on-screen captions for narrate steps. */
  captions: boolean;
  /** Present the recording as an inset, rounded "app card" on a background
   * (Screen-Studio style). When false, the video fills the frame edge-to-edge. */
  framed: boolean;
  // Remotion requires composition props to be assignable to Record<string, unknown>.
  [key: string]: unknown;
}

export const EMPTY_TIMELINE: Timeline = {
  version: 1,
  width: 1280,
  height: 800,
  durationMs: 1000,
  cursor: [{ t: 0, x: 640, y: 400 }],
  events: [],
};
