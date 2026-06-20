import React from "react";
import { Composition } from "remotion";
import { Demo } from "./Demo";
import { EMPTY_TIMELINE, type DemoCompositionProps } from "./types";

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
      } satisfies DemoCompositionProps}
      // Real dimensions/duration come from the timeline via calculateMetadata.
      durationInFrames={30}
      fps={30}
      width={EMPTY_TIMELINE.width}
      height={EMPTY_TIMELINE.height}
      calculateMetadata={({ props }) => {
        const fps = props.fps ?? 30;
        return {
          fps,
          width: props.timeline.width,
          height: props.timeline.height,
          durationInFrames: Math.max(1, Math.ceil((props.timeline.durationMs / 1000) * fps)),
        };
      }}
    />
  );
};
