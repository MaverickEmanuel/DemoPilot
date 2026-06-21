# DemoPilot — Video Polish Plan

Research + a concrete, prioritized improvement plan for DemoPilot's auto-zoom /
spring-camera render pipeline, plus a ready-to-paste implementation prompt for a
separate Opus 4.8 (xhigh thinking) session.

> **Scope note (important):** Every default proposed here must work for **any**
> app or website demo, not the Acme example currently used for testing. Nothing
> below hard-codes element positions, colors, or sizes — the camera, padding, and
> backgrounds are all derived from the recording's own geometry/timeline or from
> content-agnostic presets.

> **Sourcing note:** Live web fetch was blocked in the authoring environment, so
> the competitor/technique research draws on prior knowledge (cutoff Jan 2026)
> cross-checked against one live search. Canonical source URLs are listed at the
> end; treat parameter values as starting points to tune by eye.

---

## 0. How the pipeline works today (ground truth from the code)

| Concern | Where | Current behavior |
|---|---|---|
| Action grouping | `packages/compositor/src/groups.ts` | Clicks/typing merged into "action groups" by shared container / temporal proximity / explicit `group` markers. Each group → a union `bbox`. |
| Camera | `packages/compositor/src/camera.ts` | Critically-ish-damped spring (`stiffness≈8`, `damping≈0.92`, sub-stepped at 240 Hz) chases a time-varying target `{scale, originX, originY}`. Adaptive depth: `depthFor()` picks scale so the bbox fills `fill=0.5` of the viewport, clamped to `[minZoom 1.15, maxZoom ~1.85]`. Anchor clamped to a `SAFE_X=0.12 / SAFE_Y=0.14` inset. Output = uniform per-frame `CameraState[]`. |
| Compositing | `packages/compositor/src/Demo.tsx` | Recording shown as an inset "app card" (rounded, shadowed) on a gradient, on a fixed **1920×1080** canvas. **Camera applied as `transform: scale(cam.scale)` + `transform-origin: originX px originY px`** inside the card's `overflow:hidden` clip. Cursor uses the *same* transform but outside the clip. |
| Framing/background | `packages/compositor/src/frame.ts` | `CANVAS = 1920×1080`; `cardLayout()` fits the recording into a `pad=54px` margin. Backgrounds = 4 CSS-gradient presets (`midnight`/`dusk`/`daylight`/`aurora`). |
| Cursor | `packages/compositor/src/Cursor.tsx` | Redrawn macOS SVG arrow, fixed 28px box × `cursorScale=1.5`, dips to 0.86 on press. Position: centripetal Catmull-Rom through samples (`interp.ts`) — already nicely smoothed. |
| Click FX | `Demo.tsx` `Ripple` | Filled disc flash + expanding ring, 480 ms. |
| Captions / intro / outro | `Demo.tsx`, `interp.ts` | Narrate→caption with fades; black cover before first paint; 300 ms fade-out. |
| FPS | `Root.tsx` | **30 fps.** |

---

## 1. Diagnosis of the current render (frame-by-frame)

Extracted the attached 17.6 s / 1080p30 clip to frames. What's actually wrong:

1. **Edge targets get clipped — the #1 issue.** Zooming the **top-right "New
   Project" button** shows "New Proj…" cut off at the right edge; the **"Welcome
   to Acme"** header and "No projects yet" text are pushed *above* the visible
   card; the **"New project" dialog** is clipped on the *left* ("…ew project",
   "…roject name"). This is exactly your "doesn't move up and right enough."

   **Root cause:** the camera scales around a `transform-origin` that is **clamped
   12%/14% inward** (`anchorFor` + `SAFE_X/SAFE_Y`). `scale(s)` keeps the origin
   point fixed and pushes everything *else* outward by `s`. A target near a corner
   is *further* from the clamped origin, so it's flung toward/past the edge as `s`
   grows. The clamp that's meant to avoid corners is what *causes* the cut-off.
   The `transform-origin` model fundamentally cannot frame an edge element without
   either clipping it or revealing background.

2. **Padding is currently constant** (camera transform lives inside the card
   clip, so the card/shadow/margin don't move). Good — but the model is fragile:
   nothing guarantees the scaled video keeps *covering* the card, so off-center
   zooms can in principle reveal the stage color at a card edge. The fix in §3.1
   makes "constant padding + content-only zoom + never-cut-off" a hard guarantee.

3. **30 fps + fast moves = judder.** The spring is smooth, but the quick
   transitions (jump to the top-right button; dialog open) and faster cursor
   travel stutter at 30 fps. This is where motion blur earns its keep (§3.4).

4. **Cursor scales *with* the camera.** The cursor group inherits `scale(cam.scale)`,
   so at 1.85× zoom × 1.5 `cursorScale` the pointer balloons to ~2.7× — larger
   than any real OS cursor and larger than Screen Studio's (which holds a roughly
   constant *on-screen* size). Minor, but it reads slightly "off."

---

## 2. Priority summary

| P | Item | Impact | Effort | Files |
|---|---|---|---|---|
| **P0** | Fit-to-rect + edge-clamped camera (kills cut-off; makes padding a hard guarantee) | ★★★★★ | M | `camera.ts`, `Demo.tsx`, `camera.test.ts` |
| **P0** | Constant outer padding + inner safe-area as the camera contract | ★★★★☆ | S (falls out of P0) | `camera.ts`, `frame.ts` |
| **P1** | Mesh / multi-stop gradient backgrounds (generalizable presets) | ★★★★☆ | S–M | `frame.ts` |
| **P1** | 60 fps + motion blur **on by default** (camera + cursor) | ★★★★☆ | M | `Root.tsx`, `Demo.tsx`, new `MotionBlur` helper |
| **P2** | Cursor in screen-space (constant size), tuned click FX | ★★★☆☆ | S | `Demo.tsx`, `Cursor.tsx` |
| **P2** | Dwell/hold timing, speed-ramp idle gaps, vignette, intro/outro, keystroke captions | ★★★☆☆ | M | `camera.ts`, `Demo.tsx` |

---

## 3. The improvements (technique · parameters · difficulty)

### 3.1 — P0 · Fit-to-rect, edge-clamped camera  *(replaces transform-origin scaling)*

**Why.** Premium tools don't "scale around a point"; they **fit a target
rectangle into a viewport and clamp the result so the content never leaves the
frame**. That single change fixes the cut-off, the "not far enough" corner
framing, and guarantees constant padding.

**The model.**

- The camera's *viewport* is the fixed app card (`vw × vh` in card space).
- Define an **inner safe area** = the card inset by a margin (e.g. 8–12%). The
  focus rect is fit into the safe area, never the bare edge → automatic breathing
  room (this is the "add padding, then zoom on top of the padding" you asked for:
  outer card margin is constant; the inner margin keeps focused content off the
  card edge).
- Per group, the spring chases a **focus center** `(fx, fy)` (bbox center) and a
  **target scale** `s` = `min(safeW/bboxW, safeH/bboxH)` clamped to `[minZoom, maxZoom]`.
- **Per frame**, convert `(fx, fy, s)` to a transform with **`transform-origin: 0 0`**:

  ```
  tx = vw/2 - fx * s
  ty = vh/2 - fy * s
  // Hard coverage clamp — THIS is what fixes everything:
  tx = clamp(tx, -vw*(s-1), 0)
  ty = clamp(ty, -vh*(s-1), 0)
  transform: `translate(${tx}px, ${ty}px) scale(${s})`
  ```

  The clamp keeps `[tx, tx+vw·s]` ⊇ `[0, vw]` (and same for y), so the scaled
  video **always fully covers the card** → no background bleed, ever. For a
  corner target the clamp pins translation to its limit, framing the element *as
  far into the corner as geometry allows* — i.e. it finally "moves up and to the
  right enough," and the element stays fully on-screen instead of being clipped.

**Implementation shape.**

- Change `CameraState` to carry focus center + scale (e.g. `{ scale, focusX, focusY }`)
  or keep `{scale, originX, originY}` but reinterpret as the focus center.
- Add a pure, unit-testable helper `cameraTransform(cam, vw, vh) → {tx, ty, scale}`
  (do the clamp here, not inline in JSX) so it's covered by `camera.test.ts`.
- In `Demo.tsx`, replace `camStyle.transform`/`transformOrigin` with the helper's
  `translate(tx,ty) scale(scale)` and `transform-origin: 0 0`. Apply the **same**
  transform to the video group and the cursor group (keep them pixel-aligned).
- Delete `SAFE_X/SAFE_Y` corner-clamping of the anchor (the safe-area fit + the
  coverage clamp supersede it). Keep `anchorFor` only as the raw bbox center.
- Keep the spring exactly as-is (it already produces nice motion); only the
  *target* and the *application* change.

**Parameters (content-agnostic defaults):** `innerSafeX = 0.10`, `innerSafeY = 0.10`,
`minZoom = 1.0` (allow "no zoom" for big regions), `maxZoom = 1.8`,
`fill` replaced by the safe-area fit. Cap `maxZoom` so you never upscale the
(already downscaled) screencast past softness — see §5 on source resolution.

**Difficulty:** Medium. ~1 focused day. Mostly `camera.ts` + a few lines in
`Demo.tsx`; the math is small and very testable.

---

### 3.2 — P0 · Constant padding contract  *(falls out of 3.1)*

You already keep the card fixed. Formalize it so it can't regress:

- **Outer padding** = `cardLayout` margin (currently `pad=54`); constant for the
  whole render. Consider bumping to ~5.5–7% of canvas height for a more
  "product-shot" feel (Screen Studio uses generous, *constant* padding).
- **Inner safe area** = §3.1's margin; the zoom never targets inside it.
- Add a one-line invariant comment + a test asserting the coverage clamp holds at
  `maxZoom` for corner focus points, so "content never escapes the card" is
  guaranteed.

**Difficulty:** Small (mostly comes for free with 3.1).

---

### 3.3 — P1 · Mesh / multi-stop gradient backgrounds  *(generalizable)*

You picked **mesh / multi-stop gradients**. These are the most "Screen-Studio"
backdrop and stay tasteful behind *any* UI (dark or light), with zero assets.

**Technique.** Layer several large, soft `radial-gradient` color blobs over a base
linear gradient (a CSS "mesh gradient"). All in `frame.ts`'s `BACKGROUNDS` map, so
they're selectable per render and content-agnostic.

```css
/* "aurora-mesh" example — stack radial blobs, comma-separated, over a base */
background:
  radial-gradient(60% 55% at 18% 22%, rgba(124,109,255,0.45) 0%, transparent 60%),
  radial-gradient(55% 50% at 82% 18%, rgba(58,120,255,0.40) 0%, transparent 62%),
  radial-gradient(70% 60% at 75% 85%, rgba(180,80,200,0.35) 0%, transparent 60%),
  linear-gradient(135deg, #161a2e 0%, #0d1020 100%);
```

Ship ~4–6 presets (a cool one, a warm one, a neutral-light one, a vivid brand one).
Keep the existing 4 for back-compat; add the mesh variants and make a mesh preset
the default. **Optional drift:** animate blob positions with `useCurrentFrame`
(e.g. ±3–5% over ~20 s, sinusoidal) for subtle life — cheap (CSS only, 1× render).

**Difficulty:** Small for static presets; Small–Medium with drift. ~½ day.

> Deferred per your answers: image wallpapers, brand-color auto-sampling, and
> film-grain/parallax are **not** in this pass — noted in §6 as future work.

---

### 3.4 — P1 · 60 fps + motion blur (ON by default)

**First, go 60 fps.** It's the single biggest "smoothness" win and halves
per-frame motion (so less blur is needed). Change `fps` default to 60 in
`Root.tsx`/props. Render cost ~2× frames; worth it for marketing output.

**Motion blur — recommended default-on approach: cheap synthetic blur** (≈1×
render cost), with Remotion's `@remotion/motion-blur` documented as the
high-quality opt-in.

You enabled motion blur **on by default**, so the default must stay render-viable.
Remotion's `<CameraMotionBlur>` is gorgeous but multiplies render time by its
`samples` count (it re-renders children at sub-frame offsets and averages). That's
fine as an opt-in "max quality" path, but too heavy for an always-on default.

**(a) Camera (zoom/pan) blur — synthetic, default on.**
Compute the camera's per-frame speed from the keyframe track (Δtranslate between
adjacent frames, already available). Map speed → a small blur and apply it to the
moving content group:

```
const speed = Math.hypot(tx - txPrev, ty - tyPrev) + Math.abs(s - sPrev) * vw; // px/frame
const blurPx = clamp(speed * 0.05, 0, 7);
// style: filter: `blur(${blurPx}px)`   (isotropic; cheap)
```

Isotropic CSS blur is a good-enough approximation for camera moves (the eye reads
"smear during fast move, crisp on hold"). For *directional* blur, wrap the group in
an SVG `feGaussianBlur` with `stdDeviation="{bx} {by}"` aligned to the velocity
vector — nicer, still 1× cost, a bit more plumbing.

**(b) Cursor blur — synthetic trail, default on.**
The cursor is the fastest-moving element. Draw 3–5 ghost copies along the recent
Catmull-Rom path (sample `cursorAt` at `t-1f … t-4f`), opacity falloff `~0.5ⁿ`,
**only when speed exceeds a threshold** (e.g. > 1200 px/s in video space) so
slow/precise moves stay crisp. This is exactly what Remotion's `<Trail>` does;
rolling it by hand keeps the cursor in screen-space (see §3.5) and costs ~nothing.

**High-quality opt-in:** wrap the moving content in
`<CameraMotionBlur shutterAngle={180} samples={8}>` for the camera and `<Trail>`
for the cursor. Gate behind a `motionBlur: "synthetic" | "sampled" | "off"` prop
defaulting to `"synthetic"`.

**Parameters:** `shutterAngle 180` (a half-frame exposure — the film standard;
higher = more blur), `samples 8–12` for sampled mode. Synthetic: `blur gain 0.04–0.06`,
`max 6–8px` at 60 fps; cursor trail `4 layers`, `1-frame spacing`, `speed gate ~1200 px/s`.

**Is it worth it?** Yes — *with* the 60 fps bump and *because* your moves are
camera-driven (large, fast translations of the whole frame are the textbook case
where 30 fps judders and blur fixes it). Keep it subtle; over-blurring reads as
"laggy," not cinematic.

**Difficulty:** Medium. Synthetic path ~1 day. Sampled opt-in ~½ day more.

---

### 3.5 — P2 · Cursor in screen-space + tuned click FX

- **Decouple cursor size from zoom.** Move the cursor out of the camera-scaled
  group; apply only its *position* through the camera (`p' = cameraTransform · p`)
  but render the glyph at a constant on-screen size (×`cursorScale`, no `cam.scale`).
  Result: pointer stays a consistent, readable size whether wide or zoomed —
  matches Screen Studio/Cap. Keep the tip hotspot exact.
- **Cursor size:** bump base to ~32–36px on-screen (Screen Studio's default cursor
  is noticeably larger than the OS pointer for legibility).
- **Click FX:** keep the ripple but make it screen-space too (constant size).
  Consider a brief **cursor scale-pop** (1.0→0.85→1.0 over ~140 ms) synced to the
  press, plus an optional soft "spotlight" dim of everything but a radius around
  the click for emphasis on key actions.

**Difficulty:** Small. ~½ day.

---

### 3.6 — P2 · Timing, ramps, vignette, intro/outro, keystroke captions

- **Dwell/hold:** ensure every zoom *holds* ≥ ~700–900 ms after settling before
  moving on (you have `TAIL_MS=700`; verify it survives the new model). Pros let
  the viewer *read* before the next move.
- **Idle speed-ramp:** when there's a long dead gap between groups (no actions),
  optionally time-compress it (speed-ramp the underlying video) so the demo never
  stalls. Medium effort (needs frame remapping of `OffthreadVideo`).
- **Vignette:** a very subtle radial darkening at the canvas edges (`box-shadow:
  inset` or a radial overlay at ~8–12% opacity) adds depth. Trivial, 1× cost.
- **Intro/outro:** you have fades; consider a 300–500 ms gentle scale-in of the
  whole card at the start (1.02→1.0) and a matching settle at the end — reads as
  "produced." Small.
- **Keystroke captions:** optional on-screen key-cap badges for typed shortcuts
  (e.g. `⌘K`). Nice for product demos; Medium (needs key metadata in timeline).
- **Sound design:** subtle UI click ticks + a soft ambient pad bed dramatically
  lift perceived quality. Out of the render pipeline's scope but worth a backlog
  note (mux in `ffmpeg.ts`).

---

## 4. Research — how the best tools get the premium feel

### 4.1 Screen Studio (the bar)

- **Auto-zoom trigger:** click-driven. Essentially *every click becomes a zoom
  keyframe* — no ROI/velocity heuristics; it trusts that clicks mark intent. It
  groups rapid clicks and tracks natural interaction patterns. (Your container/
  proximity grouping is actually *more* sophisticated than the base model.)
- **Easing/spring:** spring-based with user-exposed **tension / friction / mass**
  plus slow→rapid speed presets for both cursor and zoom. (You already spring;
  consider surfacing these knobs.)
- **Cursor smoothing & size:** a motion-smoothing algorithm interpolates raw mouse
  positions into fluid curves ("like manual smoothing in After Effects, but
  automatic"); cursor is rendered larger than the OS pointer and at a roughly
  constant on-screen size. (You smooth via Catmull-Rom — good; adopt constant
  on-screen size, §3.5.)
- **Click effects:** subtle highlight/ripple + cursor reaction on press.
- **Auto-padding & backgrounds:** generous, *constant* padding; rounded corners +
  soft shadow; gradient/mesh/image/solid backgrounds (incl. macOS-style wallpapers
  and color presets).
- **Motion blur:** **on by default**, configurable *independently* for cursor
  movement, zoom, and pan — "subtle, cinematic smoothness… like a professional
  editing suite." This is the feature that makes their fast moves look buttery;
  it's exactly what §3.4 replicates.

### 4.2 Competitors — techniques worth stealing

- **Cap (cap.so, open source — MIT, Rust/Tauri + GPU):** does zoom/blur on the GPU
  (wgpu shaders) rather than CSS, which is why their blur is cheap and real
  (directional). The transferable idea: **velocity-driven directional blur on the
  composited frame** (§3.4b). Their editor uses zoom "segments" with spring
  in/out — same shape as your shots/gaps. Worth reading their renderer for the
  shader math if you ever move off CSS.
- **Tella:** "frames & backgrounds," auto-zoom, and *scene-based* editing — splits
  a recording into reorderable scenes. Steal: scene/segment model for re-takes.
- **Focusee (iMobie):** budget Screen-Studio clone — auto-zoom + cursor effects +
  backgrounds; nothing novel but confirms the feature set is now table stakes.
- **Jumpshare / CleanShot X:** excellent cursor highlighting, click rings, and
  *clean* defaults; CleanShot's restrained click highlight is a good reference for
  not over-doing FX.
- **Screencastify / Loom:** webcam-bubble + light cursor highlight; minimal auto-
  cinematography. Loom's value is speed/sharing, not polish — not a polish target.
- **Descript:** transcript-driven editing + "Studio Sound"; their *audio* polish
  (filler-word removal, sound) is the steal, not the camera.
- **Arcade / Supademo:** interactive *HTML* walkthroughs (not video) with
  auto-zoom-to-clicked-element and hotspot callouts. Steal: their
  **zoom-to-the-clicked-element-rect** is precisely the fit-to-rect model in §3.1,
  and their step **callouts/annotations** are a good optional overlay.

### 4.3 Motion blur in depth

- **Worth it?** Yes for a camera-driven demo, *especially paired with 60 fps*.
  Your blur need is dominated by (a) the camera translate/scale during transitions
  and (b) fast cursor travel — both are large, coherent motions that judder at
  30 fps and smooth beautifully with a little blur. It is **not** worth heavy
  multi-sample blur as an always-on default (render cost); the synthetic approach
  gives ~90% of the look at ~1× cost.
- **(a) Camera blur** — you *know* the velocity analytically (diff the keyframe
  track). Cheapest correct-looking result: directional blur aligned to the camera
  velocity (SVG `feGaussianBlur` `stdDeviation="bx by"`), magnitude ∝ px/frame.
  Isotropic CSS `blur()` is the 5-minute version and still reads well.
- **(b) Cursor blur** — trail/echo (N ghosts along the path) is the standard and
  is what `@remotion/motion-blur`'s `<Trail>` does. Gate by speed so precise moves
  stay crisp.
- **Remotion specifics:** `@remotion/motion-blur` exposes `<Trail>` (frame echoes;
  props for layers / lag) and `<CameraMotionBlur>` (`shutterAngle` default 180,
  `samples` default 10 — renders children at sub-frame offsets and averages).
  Sampling cost ≈ `samples ×` base render. Use `shutterAngle 180` (half-frame
  exposure) as the cinematic default. Recommendation: **synthetic by default,
  `<CameraMotionBlur samples={8..12}>` as a `motionBlur:"sampled"` opt-in.**
- **Params recap:** 60 fps; synthetic gain `0.04–0.06`, cap `6–8px`; cursor trail
  4 layers @ 1-frame spacing, speed gate ~1200 px/s; sampled `shutterAngle 180`,
  `samples 8–12`.

### 4.4 Amateur → professional checklist

Cursor smoothing ✓ (have) · constant-size larger cursor · acceleration/ease on
cursor moves · **dwell/hold long enough to read** · zoom that frames the *element
rect* (not a point) · constant generous padding · soft shadow + rounded corners ·
tasteful mesh background · **motion blur on fast moves** · 60 fps · subtle vignette/
depth · clean intro/outro · speed-ramp dead air · optional keystroke captions ·
sound design (clicks + ambient bed) · never zoom so far the UI pixelates.

---

## 5. Cross-cutting quality notes

- **Source resolution vs. zoom:** the screencast is fit into a card *smaller* than
  1920×1080, then zoomed up to `maxZoom`. That's upscaling-on-upscaling → softness
  at high zoom. Mitigations: cap `maxZoom ≈ 1.8`; record/capture at ≥ the canvas
  card size (ideally 2× for retina crispness); prefer framing larger element rects
  over punching deep into tiny ones.
- **Keep all overlays in one coordinate space.** The new `cameraTransform` must be
  applied identically to video + cursor + ripple, or they'll drift. Centralize it.
- **Determinism:** the spring is simulated once into a keyframe track — keep it
  that way so renders are reproducible and testable.

## 6. Explicitly deferred (per your choices)

Image-wallpaper backgrounds · brand-color auto-sampling · film grain / parallax
drift · speed-ramping · keystroke captions · sound design. Revisit after P0/P1.

---

## 7. Implementation prompt for Opus 4.8 (xhigh thinking)

> Paste the block below into a **fresh** Claude Code conversation with Opus 4.8
> and extended/xhigh thinking. It's phased: **camera + padding first**, then
> backgrounds, then 60 fps + motion blur.

```text
You are working on DemoPilot, an MCP tool that records browser interactions and
renders polished marketing demo videos with Remotion (React + OffthreadVideo +
CSS transforms) and a spring-physics auto-zoom camera. Read VIDEO_POLISH.md in the
repo root first — it contains the full diagnosis and rationale. Then implement the
plan in PHASES, in order, committing after each phase. Work on the current feature
branch; do NOT open a PR unless I ask.

HARD CONSTRAINT: every default must generalize to ANY app/website demo. Do not
hard-code element positions, colors, sizes, or anything specific to the Acme
example. All behavior must derive from the recording's timeline/geometry or from
content-agnostic presets.

Key files: packages/compositor/src/{camera.ts, Demo.tsx, frame.ts, Cursor.tsx,
groups.ts, interp.ts, Root.tsx, types.ts} and test/camera.test.ts.

PHASE 1 (P0) — Fit-to-rect, edge-clamped camera + constant padding:
- Replace the transform-origin scaling with a fit-to-rect camera. The camera's
  viewport is the fixed app card (vw×vh card space). Define an inner safe area
  (card inset ~10%). Per action group, the spring chases the bbox center
  (focusX, focusY) and a target scale s = min(safeW/bboxW, safeH/bboxH) clamped to
  [minZoom, maxZoom] (minZoom=1.0, maxZoom=1.8).
- Add a PURE helper cameraTransform(cam, vw, vh) -> {tx, ty, scale} that does:
    tx = vw/2 - focusX*s;  ty = vh/2 - focusY*s;
    tx = clamp(tx, -vw*(s-1), 0);  ty = clamp(ty, -vh*(s-1), 0);
  This coverage clamp guarantees the scaled video always fully covers the card
  (no background bleed) and frames edge/corner elements fully on-screen instead of
  clipping them. Keep the spring integration exactly as it is — only change the
  TARGET it chases and how the result is APPLIED.
- In Demo.tsx, apply transform: translate(tx,ty) scale(scale) with
  transform-origin "0 0" to BOTH the video group and the cursor group (keep them
  pixel-aligned). Remove SAFE_X/SAFE_Y anchor corner-clamping.
- Verify the prior bug is gone: the top-right "New Project" button and the left
  edge of the "New project" dialog must NOT be clipped, and the camera must move
  fully into corners. Keep outer card padding constant the entire render.
- Add unit tests in camera.test.ts asserting: (1) coverage clamp holds at maxZoom
  for corner focus points (content never escapes [0,vw]×[0,vh]); (2) a centered
  target is exactly centered; (3) padding/card layout is unaffected by zoom.

PHASE 2 (P1) — Mesh gradient backgrounds:
- In frame.ts, add ~4-6 mesh/multi-stop gradient presets (stacked soft
  radial-gradient blobs over a base linear gradient) covering cool/warm/neutral-
  light/vivid. Keep the existing presets for back-compat; make a mesh preset the
  default. Pure CSS, no assets. (Optional, behind a flag: subtle sinusoidal drift
  of blob positions via useCurrentFrame, ±3-5% over ~20s.)

PHASE 3 (P1) — 60 fps + motion blur (ON by default, cheap/synthetic):
- Bump default fps to 60 (Root.tsx + props).
- Add motionBlur prop: "synthetic" (default) | "sampled" | "off".
- Synthetic camera blur: from the keyframe track compute per-frame speed
  (delta translate + |delta scale|*vw); blurPx = clamp(speed*0.05, 0, 7); apply
  filter: blur(blurPx) to the moving content group. Prefer directional SVG
  feGaussianBlur aligned to velocity if straightforward; isotropic CSS blur is an
  acceptable first cut.
- Synthetic cursor trail: draw 4 ghost cursors sampled at t-1f..t-4f along the
  Catmull-Rom path, opacity falloff ~0.5^n, ONLY when cursor speed > ~1200 px/s.
- "sampled" mode: wrap moving content in @remotion/motion-blur
  <CameraMotionBlur shutterAngle={180} samples={8}> and the cursor in <Trail>.
  Note the Nx render-cost tradeoff in a comment.

PHASE 4 (P2, optional if time) — Cursor in screen-space (constant on-screen size,
base ~32-36px; apply only POSITION through the camera, not scale), cursor press
scale-pop synced to clicks, and a subtle edge vignette.

For each phase: keep changes minimal and idiomatic to the surrounding code, run
the existing test suite, add/adjust tests, and commit with a clear message. After
all phases, render the existing example and confirm: no clipping at edges/corners,
constant padding, smooth 60 fps motion, tasteful background. Report what you
changed and any params you tuned by eye.
```

---

## 8. Sources

- Screen Studio — Animations & motion guide: https://screen.studio/guide/animations-motion
- Screen Studio (product): https://screen.studio
- "How to Auto-Zoom in Screen Recordings" — Screenify: https://www.screenify.studio/blog/2026-04-10-auto-zoom-screen-recording
- "Smooth cursor in recordings" — Screenify: https://www.screenify.studio/blog/2026-04-20-smooth-cursor-recording
- Screen Studio review (cursor/zoom/blur behavior): https://daveswift.com/screen-studio/
- Cap (open source recorder): https://cap.so · source: https://github.com/CapSoftware/Cap
- Tella: https://www.tella.tv
- Focusee: https://www.imobie.com/focusee/
- CleanShot X: https://cleanshot.com
- Jumpshare: https://jumpshare.com
- Loom: https://www.loom.com · Descript: https://www.descript.com
- Arcade: https://www.arcade.software · Supademo: https://supademo.com
- Remotion motion blur (`<Trail>`, `<CameraMotionBlur>`, shutterAngle/samples): https://www.remotion.dev/docs/motion-blur
- Remotion springs: https://www.remotion.dev/docs/spring
```
