// Screen-Studio-style framing: the clean recording is presented as an inset
// "app card" on a tasteful background, with rounded corners and a soft shadow,
// instead of a raw edge-to-edge screen grab.
//
// For marketing output the composition is a fixed 16:9 1080p canvas; the app
// card is scaled to fit and centered on a gradient background. The card (and the
// overlays inside it) work in VIDEO pixel coordinates and are visually scaled by
// a single wrapper transform, so cursor/ripple/camera coordinates stay valid.
//
// CRITICAL: the camera zoom scales only the *content inside* the card — never the
// card itself. Keeping the card fixed in the layout is what makes it read as a
// composed product shot rather than a moving rectangle.

export interface FrameStyle {
  /** Background margin (px) around the app card, in canvas space. */
  pad: number;
  /** Corner radius (px) of the app card, in video space. */
  radius: number;
  /** Composition background behind the card. */
  background: string;
  /** Soft drop shadow lifting the card off the background. */
  shadow: string;
}

/** Named background presets, selectable per render. */
export const BACKGROUNDS: Record<string, string> = {
  // A calm, slightly-cool dark gradient with a soft glow from the top — premium
  // and understated, and a natural backdrop for a dark app UI.
  midnight: "radial-gradient(130% 110% at 50% -10%, #2a3352 0%, #141a30 48%, #0b0f1e 100%)",
  // A warm dusk gradient for lighter UIs.
  dusk: "linear-gradient(150% 150% at 20% 0%, #3a2b4d 0%, #241a33 50%, #120c1c 100%)",
  // A clean, bright neutral for product shots on a light page.
  daylight: "radial-gradient(120% 120% at 50% 0%, #eef1f7 0%, #d9dee9 60%, #c4cbdb 100%)",
  // A vivid brand-leaning gradient for hero loops.
  aurora: "linear-gradient(135deg, #1b2a4a 0%, #2b1f54 45%, #3a1f47 100%)",
};

export const FRAME: FrameStyle = {
  // ~5% margin around the card (5% of the 1080p canvas height). The recording is
  // 16:10 inside a 16:9 canvas, so the card is height-limited and this sets the
  // top/bottom breathing room; left/right fall out of preserving the aspect.
  pad: 54,
  radius: 16,
  background: BACKGROUNDS.midnight,
  // Two layers: a broad ambient lift plus a tighter contact shadow.
  shadow: "0 40px 90px -30px rgba(0,0,0,0.75), 0 10px 28px -12px rgba(0,0,0,0.55)",
};

/** The fixed marketing canvas: 16:9 at 1080p. */
export const CANVAS = { width: 1920, height: 1080 };

/** Resolve a background by preset name (falls back to the default gradient). */
export function backgroundFor(name?: string): string {
  if (!name) return FRAME.background;
  return BACKGROUNDS[name] ?? name; // allow a raw CSS background string too
}

/** Composition size. Framed output is a fixed 16:9 1080p canvas; unframed output
 * matches the recording exactly. */
export function framedSize(
  videoWidth: number,
  videoHeight: number,
  framed = true,
): { width: number; height: number } {
  if (!framed) return { width: videoWidth, height: videoHeight };
  return { width: CANVAS.width, height: CANVAS.height };
}

export interface CardLayout {
  /** Uniform scale applied to the (videoWidth × videoHeight) card. */
  scale: number;
  /** Top-left of the scaled card within the canvas. */
  left: number;
  top: number;
}

/** Fits the video card into the padded canvas, preserving aspect and centering. */
export function cardLayout(
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
  pad: number = FRAME.pad,
): CardLayout {
  const availW = canvasWidth - pad * 2;
  const availH = canvasHeight - pad * 2;
  const scale = Math.min(availW / videoWidth, availH / videoHeight);
  const cardW = videoWidth * scale;
  const cardH = videoHeight * scale;
  return { scale, left: (canvasWidth - cardW) / 2, top: (canvasHeight - cardH) / 2 };
}
