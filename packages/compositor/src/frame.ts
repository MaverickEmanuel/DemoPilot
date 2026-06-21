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

// ---------------------------------------------------------------------------
// Mesh gradients
//
// A "mesh" backdrop layers several large, soft radial-gradient color blobs over
// a base linear gradient (the most "Screen-Studio" look, with zero assets).
// Presets are stored structurally — a base plus a list of blobs — so the same
// data can render a static CSS string OR a gently drifting one (meshBackgroundAt).
// All presets are content-agnostic: they sit behind any UI, light or dark, and
// never reference the recorded app.
// ---------------------------------------------------------------------------

/** One soft radial blob, sized/placed as percentages of the canvas. */
interface MeshBlob {
  /** Ellipse size (% of canvas width/height). */
  w: number;
  h: number;
  /** Center position (% of canvas). */
  x: number;
  y: number;
  /** rgba() color string at the blob center. */
  color: string;
  /** Percentage at which the blob fully fades to transparent. */
  stop: number;
}

interface Mesh {
  /** Base gradient painted behind the blobs (the canvas tone). */
  base: string;
  blobs: MeshBlob[];
}

/** Structured mesh presets — cool, warm, neutral-light, and vivid. */
export const MESHES: Record<string, Mesh> = {
  // Cool / vivid — indigo→blue→magenta blobs over deep navy. The default:
  // premium and understated behind a dark UI, still tasteful behind a light one.
  "aurora-mesh": {
    base: "linear-gradient(135deg, #161a2e 0%, #0d1020 100%)",
    blobs: [
      { w: 62, h: 56, x: 16, y: 20, color: "rgba(124,109,255,0.45)", stop: 60 },
      { w: 56, h: 50, x: 84, y: 16, color: "rgba(58,120,255,0.40)", stop: 62 },
      { w: 72, h: 62, x: 78, y: 86, color: "rgba(180,80,200,0.34)", stop: 60 },
      { w: 60, h: 58, x: 24, y: 92, color: "rgba(64,160,220,0.28)", stop: 64 },
    ],
  },
  // Cool — cyan/teal/blue over near-black navy; calm and techy.
  nebula: {
    base: "linear-gradient(160deg, #0c1424 0%, #070b16 100%)",
    blobs: [
      { w: 66, h: 60, x: 22, y: 18, color: "rgba(56,148,236,0.40)", stop: 62 },
      { w: 58, h: 54, x: 86, y: 30, color: "rgba(40,200,200,0.30)", stop: 60 },
      { w: 70, h: 64, x: 70, y: 90, color: "rgba(90,110,240,0.30)", stop: 62 },
    ],
  },
  // Warm — amber/coral/magenta over a dark plum base; energetic, brand-leaning.
  ember: {
    base: "linear-gradient(150deg, #221327 0%, #140a14 100%)",
    blobs: [
      { w: 64, h: 58, x: 18, y: 24, color: "rgba(255,150,70,0.40)", stop: 60 },
      { w: 58, h: 54, x: 84, y: 18, color: "rgba(240,80,120,0.36)", stop: 62 },
      { w: 72, h: 64, x: 80, y: 88, color: "rgba(190,60,150,0.32)", stop: 60 },
    ],
  },
  // Warm-light — peach/rose/gold over a soft cream; great behind a light UI.
  dawn: {
    base: "linear-gradient(160deg, #fbf1ec 0%, #f3e3df 100%)",
    blobs: [
      { w: 66, h: 60, x: 16, y: 18, color: "rgba(255,196,150,0.55)", stop: 62 },
      { w: 60, h: 56, x: 86, y: 22, color: "rgba(255,170,190,0.50)", stop: 62 },
      { w: 70, h: 64, x: 78, y: 90, color: "rgba(255,214,150,0.45)", stop: 60 },
    ],
  },
  // Neutral-light — soft blue/violet haze over near-white; clean product shot.
  mist: {
    base: "linear-gradient(160deg, #f4f6fb 0%, #e6eaf3 100%)",
    blobs: [
      { w: 66, h: 60, x: 20, y: 18, color: "rgba(150,170,230,0.45)", stop: 64 },
      { w: 60, h: 56, x: 85, y: 26, color: "rgba(180,160,225,0.40)", stop: 64 },
      { w: 70, h: 64, x: 74, y: 90, color: "rgba(150,200,225,0.36)", stop: 62 },
    ],
  },
  // Vivid — saturated multi-hue spread over dark; a bold hero loop.
  spectrum: {
    base: "linear-gradient(135deg, #12132a 0%, #0a0b18 100%)",
    blobs: [
      { w: 60, h: 56, x: 14, y: 16, color: "rgba(120,90,255,0.45)", stop: 58 },
      { w: 56, h: 52, x: 80, y: 12, color: "rgba(40,180,255,0.42)", stop: 60 },
      { w: 58, h: 54, x: 90, y: 78, color: "rgba(255,90,160,0.40)", stop: 58 },
      { w: 64, h: 60, x: 18, y: 88, color: "rgba(60,210,170,0.34)", stop: 60 },
    ],
  },
};

/** Builds a mesh's CSS, optionally drifting blob centers by `driftFrac` (0..1
 * over a full cycle). Drift is ±~4% so the blobs breathe without churn. */
function meshCss(m: Mesh, driftFrac = 0): string {
  const TAU = Math.PI * 2;
  const amp = 4; // percent
  const layers = m.blobs.map((b, i) => {
    // Each blob gets its own phase so they drift independently (no global pulse).
    const dx = driftFrac ? Math.sin(TAU * driftFrac + i * 1.7) * amp : 0;
    const dy = driftFrac ? Math.cos(TAU * driftFrac + i * 1.1) * amp : 0;
    const x = (b.x + dx).toFixed(2);
    const y = (b.y + dy).toFixed(2);
    return `radial-gradient(${b.w}% ${b.h}% at ${x}% ${y}%, ${b.color} 0%, transparent ${b.stop}%)`;
  });
  return [...layers, m.base].join(", ");
}

/** Named background presets, selectable per render. Mesh presets are flattened
 * to their static CSS here; legacy single-gradient presets are kept verbatim. */
export const BACKGROUNDS: Record<string, string> = {
  // Mesh presets (structured above) as static CSS.
  ...Object.fromEntries(Object.entries(MESHES).map(([k, m]) => [k, meshCss(m)])),
  // --- Legacy single-gradient presets (kept for back-compat) ---
  // A calm, slightly-cool dark gradient with a soft glow from the top.
  midnight: "radial-gradient(130% 110% at 50% -10%, #2a3352 0%, #141a30 48%, #0b0f1e 100%)",
  // A warm dusk gradient for lighter UIs.
  dusk: "linear-gradient(150% 150% at 20% 0%, #3a2b4d 0%, #241a33 50%, #120c1c 100%)",
  // A clean, bright neutral for product shots on a light page.
  daylight: "radial-gradient(120% 120% at 50% 0%, #eef1f7 0%, #d9dee9 60%, #c4cbdb 100%)",
  // A vivid brand-leaning gradient for hero loops.
  aurora: "linear-gradient(135deg, #1b2a4a 0%, #2b1f54 45%, #3a1f47 100%)",
};

/** The default background preset (a mesh). */
export const DEFAULT_BACKGROUND = "aurora-mesh";

export const FRAME: FrameStyle = {
  // ~5% margin around the card (5% of the 1080p canvas height). The recording is
  // 16:10 inside a 16:9 canvas, so the card is height-limited and this sets the
  // top/bottom breathing room; left/right fall out of preserving the aspect.
  pad: 54,
  radius: 16,
  background: BACKGROUNDS[DEFAULT_BACKGROUND],
  // Two layers: a broad ambient lift plus a tighter contact shadow.
  shadow: "0 40px 90px -30px rgba(0,0,0,0.75), 0 10px 28px -12px rgba(0,0,0,0.55)",
};

/** The fixed marketing canvas: 16:9 at 1080p. */
export const CANVAS = { width: 1920, height: 1080 };

/** Resolve a background by preset name (falls back to the default mesh). */
export function backgroundFor(name?: string): string {
  if (!name) return FRAME.background;
  return BACKGROUNDS[name] ?? name; // allow a raw CSS background string too
}

/**
 * The background at a point in time, with optional sinusoidal blob drift for the
 * mesh presets (±~4% over `periodSec`). For non-mesh names (or raw CSS strings)
 * it falls back to static resolution. Pure → safe to call per frame.
 */
export function meshBackgroundAt(
  name: string | undefined,
  tSec: number,
  drift = false,
  periodSec = 24,
): string {
  const key = name ?? DEFAULT_BACKGROUND;
  const mesh = MESHES[key];
  if (!mesh) return backgroundFor(name);
  if (!drift) return meshCss(mesh);
  const frac = (((tSec % periodSec) + periodSec) % periodSec) / periodSec;
  return meshCss(mesh, frac);
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
