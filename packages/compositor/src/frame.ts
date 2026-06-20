// Screen-Studio-style framing: the clean recording is presented as an inset
// "app card" on a tasteful background, with rounded corners and a soft shadow,
// instead of a raw edge-to-edge screen grab.
//
// CRITICAL: the frame (card position, size, corners, shadow, padding) is FIXED
// in screen space. The zoom-toward-cursor scales only the *content inside* the
// card — never the card itself. If the card scaled with the zoom, a 1.13x zoom
// of a 1280px-wide video (1446px) would exceed the padded composition and the
// even inset would collapse asymmetrically. Keeping the frame fixed is what
// makes it read as a composed product shot rather than a moving rectangle.

export interface FrameStyle {
  /** Background margin (px) around the app card on every side. */
  pad: number;
  /** Corner radius (px) of the app card. */
  radius: number;
  /** Composition background behind the card. */
  background: string;
  /** Soft drop shadow lifting the card off the background. */
  shadow: string;
}

export const FRAME: FrameStyle = {
  pad: 64,
  radius: 16,
  // A calm, slightly-cool dark gradient with a soft glow from the top — premium
  // and understated, and a natural backdrop for the seed app's dark UI.
  background: "radial-gradient(130% 110% at 50% -10%, #2a3352 0%, #141a30 48%, #0b0f1e 100%)",
  // Two layers: a broad ambient lift plus a tighter contact shadow.
  shadow: "0 24px 60px -22px rgba(0,0,0,0.72), 0 6px 18px -8px rgba(0,0,0,0.5)",
};

/** Composition size once the framing padding is added around the video. */
export function framedSize(
  videoWidth: number,
  videoHeight: number,
  pad: number = FRAME.pad,
): { width: number; height: number } {
  return { width: videoWidth + pad * 2, height: videoHeight + pad * 2 };
}
