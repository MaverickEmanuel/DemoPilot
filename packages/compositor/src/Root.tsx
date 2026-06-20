import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo";
import { EMPTY_TIMELINE, type DemoCompositionProps } from "./types";
import { framedSize } from "./frame";

const emptyFramed = framedSize(EMPTY_TIMELINE.width, EMPTY_TIMELINE.height);

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Demo"
      component={Demo}
      defaultProps={{
        videoFile: "recording.webm",
        timeline: EMPTY_TIMELINE,
        fps: 30,
        zoomOnClick: true,
        captions: true,
        framed: true,
      } satisfies DemoCompositionProps}
      // Real dimensions/duration come from the timeline via calculateMetadata.
      durationInFrames={30}
      fps={30}
      width={emptyFramed.width}
      height={emptyFramed.height}
      calculateMetadata={({ props }) => {
        const fps = props.fps ?? 30;
        // Framing adds padding around the video, so the composition is larger
        // than the recording. Overlays still use video-pixel coordinates.
        const dims =
          props.framed ?? true
            ? framedSize(props.timeline.width, props.timeline.height)
            : { width: props.timeline.width, height: props.timeline.height };
        return {
          fps,
          width: dims.width,
          height: dims.height,
          durationInFrames: Math.max(1, Math.ceil((props.timeline.durationMs / 1000) * fps)),
        };
      }}
    />
  );
};
