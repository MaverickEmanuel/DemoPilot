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

## Results (verified by re-render + frame inspection + metrics)

All shipped in commit "Fix cursor smoothness and redesign zoom…". Verified against two
fresh renders (the random typing cadence shifts event times each run, so this also
confirms the logic generalises, not just fits one timing).

- **Cursor smoothness:** velocity profiles are clean single-peak bells with no steps —
  big cross-screen move `▁▁▂▄▆██▆▄▂▁`, small move `▁▃▄█▂▁`. x-direction reversals
  3 → **0**. Click→cursor offset stays **0px** (spline passes through samples).
- **Zoom:** now eases *out* to reveal the dashboard on the form-submit navigation
  (was: zoomed into empty space); "New Project" is framed on-screen with the cursor on
  it (was: shoved to the off-screen corner by a stale, non-retargeting zoom); the form
  gets a calm focus zoom while typing; the modal interaction is centred and followed.
- **Overlays:** ripple suppressed on navigating clicks (no float on the next page);
  captions fade and hand off at the next narration; intro white flash replaced by a
  seamless dark reveal; gentle outro fade.
- **Sync:** unchanged and within tolerance (overlay-vs-element offset 0px at clicks).
- **Green:** `pnpm typecheck` and `pnpm test` (incl. the real-browser e2e) both pass.

### Tuning applied
- `natural` pace lowered 1.8 → 1.5 px/ms so long cross-screen travels glide (peak
  4.6 → 4.1 px/ms, ~410 → ~490ms for the 735px move). Short hops are unaffected (they
  hit the duration floor), so only the big moves got calmer.

### Possible future tuning (not blocking the quality bar)
- Modal-close clicks (no navigation/SPA event) still briefly ripple at the click point;
  recording a lightweight "DOM settled" marker would let the compositor react to modal
  open/close the way it now reacts to navigations.

---

# Product-walkthrough polish — working notes

Branch `polish-walkthrough` (off the cursor/zoom work). Four workstreams: pacing,
Screen-Studio framing, capture fidelity, standalone CLI. All verified by re-render +
frame inspection + timeline metrics; `pnpm typecheck` and `pnpm test` (incl. e2e) green.

## WS1 — Pacing (player + engines)
New `defaults` knobs (backward compatible): `preActionDwell` (450ms beat after the
cursor arrives), `postActionHold` (650ms after a click/type), `readPause` 600→900ms now
applied after **every** navigation (clicks detect client-side nav via `waitForLoadState`
+ url compare), and a global `speed` multiplier that scales all of the above plus mouse
travel and typing (author `pause`/`waitFor` stay literal). Verified: example 10.6s→17.4s;
the rushed action gaps 325–383ms → ~1280–1300ms; speed=1.6→11.1s, 0.7→23.9s (proportional).
Cursor smoothness (0 reversals) and click→cursor sync (0px) unchanged.

## WS2 — Framing (compositor)
Inset app card on a subtle radial-gradient background, 16px rounded corners, soft shadow
(`frame.ts`; composition grows by 2·pad). Correctness: the **frame is fixed**; only the
content inside a fixed rounded clip zooms (a frame that scaled with the 1.13× zoom would
overflow the padded canvas and collapse the inset). Video + cursor are two groups sharing
the **same** zoom transform; the cursor group sits outside the rounded clip so its tip is
never clipped. Verified on stills: at the New Project click the cursor sits exactly on the
button, ripple centred and unclipped at the corner; typing zoom keeps the cursor on the field.

## WS3 — Capture fidelity (CDP screencast)
Default capture is now CDP `Page.startScreencast`: JPEG frames (each timestamped) assembled
into a **constant-fps** H.264 MP4 with Remotion's bundled ffmpeg (`resolveBundledFfmpeg()`,
no system ffmpeg), padding static stretches by holding the last frame. recordVideo remains
an automatic fallback (`--legacy-capture` / `DEMOPILOT_CAPTURE=recordVideo`).
- **Crisper:** realtime VP8 had visible block/mosquito artifacts around text; screencast
  text edges are clean (3× crops compared). Screencast captures at CSS resolution (= the
  1× output), so overlay coordinates are unchanged.
- **Aligned:** CDP frame timestamps mapped onto the timeline wall clock (anchored on the
  first frame); clean.mp4 is 30fps CFR; click→overlay offset 0px; cursor-on-button confirmed.
- **No regressions:** replay still ~17s (screencast frame handling didn't slow pacing),
  cursor smoothness unchanged (0 reversals — cursor is composited from the timeline).

## WS4 — Standalone CLI
`demopilot render <script.yaml> [--out f.mp4] [--speed n] [--fps n] [--no-zoom|captions|frame]
[--headed] [--legacy-capture]`. Reuses playDemo+renderDemo+chrome/ffmpeg resolution; renders
against the script's own baseUrl; prints the MP4 path to stdout (logs to stderr) with a
`.timeline.json` sidecar. Wired as the `demopilot` bin + `pnpm demopilot` script; paths resolve
against `INIT_CWD`. Verified end-to-end against the seed app (speed override, --no-frame,
error handling, full screencast+framing stack).

---

# Audio — working notes

Music bed + click SFX **by default**, TTS voiceover **opt-in** behind an API key.
All muxed with Remotion's bundled ffmpeg (no system ffmpeg). New module
`packages/compositor/src/audio.ts`; options thread `render.ts → tools.ts → cli.ts`
the same way `background`/`vignette` do (render options, not script-schema fields,
so no skill-docs regen). Defaults: `music: "calm"`, `musicVolume: 0.16`, `sfx: true`,
`voiceover: false`.

## Design (content-agnostic, zero assets)
- **Music beds are synthesized from code** (like the mesh backgrounds are CSS
  recipes) — license-clear by construction, nothing downloaded/sampled. Two beds
  (`calm`, `warm`); `none` disables. A bed is a chord progression; chords are
  blended with **overlap-add raised-cosine windows** (hop = chordSec, width =
  2·chordSec) so the level stays CONSTANT (no pumping) while the loop still tiles
  seamlessly (windows wrap the loop). Global 0.8s fade in/out.
- **Click SFX**: a short decaying tick mixed at each click time, **suppressed on
  navigating clicks** (navigate within 320ms — mirrors the ripple suppression in
  interp.ts so audio and overlays agree).
- **Voiceover**: each `narrate` line → TTS (OpenAI `gpt-4o-mini-tts` or ElevenLabs,
  chosen by which API key is set) → mixed at the line's timestamp, **ducking the
  bed** to 0.34 under speech. No key (or any failure) → skipped silently, captions
  remain. Tight VO↔timeline length sync is out of scope for v1 (clips placed at
  timestamps).
- All mixing is in Node (float buffer → 16-bit WAV); ffmpeg only decodes VO and
  muxes the final AAC track. Audio is a finishing touch: any failure falls back to
  the silent video (render never fails on audio).

## Bundled-ffmpeg gotcha (cost me a debug loop)
Remotion's ffmpeg is a **trimmed build**: the raw `s16le` muxer is absent
(`-f s16le` → "format not known"). It HAS the `wav` muxer + `pcm_s16le` encoder, so
VO decode goes through a WAV container and reads the `data` chunk (not raw PCM).

## Verified (re-render + decode the muxed audio)
- MP4 carries `aac 44100 Hz mono`, duration matches the video (17.37s).
- Music bed present and quiet (~0.023 RMS); overlap-add removed the old per-chord
  pumping (min/max bed RMS ratio 0.05 → 0.62).
- SFX land at the real clicks (RMS ~0.05 spikes) and are absent at the navigating
  click; fades in/out confirmed (≈0 at both ends).
- No-key `voiceover:true` → music+SFX track, VO skipped (didVoiceover=false).
- typecheck + tests green (6 new audio unit tests; 30 compositor tests total).
