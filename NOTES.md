# Video quality improvements — working notes

Branch: `improve-video-quality`. Goal: smooth cursor + correct, well-timed zoom;
clean enough to import into Screen Studio.

## How to reproduce / verify
- `pnpm render:example` → `renders/first-demo.mp4` (+ intermediate `renders/timeline.json`
  and `renders/.capture/*.webm`, now both persisted for debugging).
- Numeric smoothness/sync analysis: `node /tmp/demopilot-analysis/analyze.mjs renders/timeline.json`
  (velocity/accel/jerk at 30fps, sample spacing, teleports, zoom-vs-click, idle spans).
- Frame extraction for visual inspection uses the Remotion-bundled ffmpeg with
  `DYLD_LIBRARY_PATH` set to its compositor-darwin-arm64 dir.

## Environment note
Playwright 1.56.0 wants Chromium rev **1194**; only **1193** is installed. Bridged with
symlinks in `~/Library/Caches/ms-playwright/` (`chromium_headless_shell-1194 -> -1193`,
`chromium-1194 -> -1193`). Environment-only; no code change.

## Baseline diagnosis (first-demo.yaml against the seed app)

Verified by rendering and inspecting frames at every click/zoom/type moment + numeric metrics.

### Sync — OK, not the problem
- Clean webm 10.56s (VP8, declared 25fps, variable frame timing); timeline 10.486s; MP4 10.56s/30fps.
- Seed UI first paints in the webm between 0.40–0.50s; timeline `navigate` (load) at 473ms.
  → video-time ≈ timeline-time within ≤1 frame (~40ms). Start offset & rate drift (0.7%) are
  within tolerance. **No CDP-screencast rewrite needed.** At click moments overlay offset = 0px.

### Zoom — the biggest visual failure
1. **Mistargeted on navigating clicks.** "Create account" (640,546) submits the form and navigates
   signup→dashboard, but the zoom/ripple still target (640,546) → zooms into the *empty centre of the
   dashboard*. The form-submit navigation was never recorded (only explicit `goto` steps were).
2. **Retarget bug.** `zoomAt` returns the *first* click whose window contains t. Click "New Project"
   (t=5940) falls inside click1's 1520ms window, so the zoom stays locked on click1's origin and never
   retargets → "New Project" is shoved into the top-right corner, partly off-screen (math: (1185,52)
   scaled 1.12 about (640,546) → screen (1250,−7)).
3. **No origin clamping / off-frame content.** Static click-point origin pushes the cursor and content
   off-screen under zoom.
4. **Linear (un-eased) in/out, starts AT the click** (after the action) instead of anticipating arrival.
5. **Modal-close click** ("Create", 758,498) zooms/ripples into empty space after the modal closes.

### Cursor — mechanics mostly OK; one real smoothness root-cause
- Dense ~16ms samples during moves; rests correctly on the active field during typing/waits; click
  points sampled exactly (0px offset). The perceived "teleport" was the zoom snap (fixed via zoom).
- **Root-cause smoothness bug:** `moveCursor` advanced position by *frame index* (`ease(i/frames)`) while
  recording *wall-clock* timestamps that include variable `page.mouse.move` latency. So equal position
  steps land at unequal times → velocity jitter under the compositor's time-based interpolation.
  Fix = advance position by *real elapsed time* so samples lie on the true ease curve in time.
- Overshoot+settle added small end-of-move x-reversals; dropped for a calmer arrival.

### Ripple / captions / intro
- Ripple 600ms; floats on stale page after nav/modal change (same root cause as zoom #1/#5).
- Captions readable; fixed 3200ms hold (polish: end at next narrate).
- **Intro:** opens on a white `about:blank` flash with a lone cursor for ~0.45s. Needs a cover/fade.

## Plan (highest impact, lowest risk first)
1. core: time-based cursor easing (smoothness); record client-side navigations (zoom nav-reset). 
2. compositor: redesign zoom envelope — ease in/out, anticipate, retarget smoothly, reset on
   navigation, subtle, origin tracks the smoothed cursor (keeps cursor in-frame) + gentle clamp.
3. compositor: smoother cursor interpolation; refine ripple; intro/outro cover + fades; caption timing.
4. Re-render + re-inspect frames + re-check metrics each iteration. Keep typecheck/test green.
</content>
