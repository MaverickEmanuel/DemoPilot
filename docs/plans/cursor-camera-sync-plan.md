# Cursor–camera synchronization plan (the "motion plan" model)

**Status:** approved design, ready to implement.
**Scope:** compositor-first (existing recordings re-render better without re-recording),
plus two small recorder changes (determinism, nothing that alters pacing).
**Decided with the project owner on 2026-07-08** — do not re-litigate the
architecture choices below; they were narrowed deliberately.

---

## 1. Symptoms (observed frame-by-frame in `firstdemo.mp4`, rendered from `examples/scripts/first-demo.yaml` on all defaults)

| t (s) | Symptom |
| --- | --- |
| 0.0–0.75 | **Cold open**: black card with a lone cursor floating on it before the form appears. |
| ~8.2 | **"Reset/snap"**: the click on *Create account* triggers an SPA navigation; the recorded content blanks to the app's dark background in one frame while the camera is still zoomed on the button. |
| 8.2–9.5 | **Ghost drift**: the cursor slides slowly across the blank page with no target, then accelerates into the next move. |
| ~11.5–12.0 | **Unnaturally fast cursor**: the travel from the *New Project* button (top-right) to the dialog's *Project name* field crosses most of the frame in ~0.4 s apparent time. |
| ~10.7–11.5 | **Dialog wobble**: the "New project" dialog visibly bounces around while the camera hunts. |
| 15.6–16.4 | Same blank-gap pattern as 8.2 s (dialog closes instantly, app spinner alone under a zoomed camera). |
| 16.5–17.6 | **Abrupt ending**: final page gets ~1 s on screen, camera still traveling as content appears, 300 ms fade. |

Two things the frame study *dis*proved (do not "fix" these):

- There is **no camera cut**. The spring (`stiffness: 8`) is continuous; the
  one-frame change at 8.2 s is the app blanking in the recorded content. A
  featureless dark page just gives no scale cues while the camera glides.
- The "ripple floating on the blank page" at ~15.7 s is the **app's own loading
  spinner**, not a compositor ripple. (`clickPulseAt`'s `NAV_SUPPRESS_MS`
  behaves correctly.)

## 2. Root causes (in code)

1. **Two uncoordinated motion systems.** Cursor travel is fixed at *recording*
   time (`packages/core/src/engines/mouse.ts` `moveCursor`: duration =
   `clamp(dist/0.9 px/ms, 240, 2200)`, `easeInOutCubic`, sampled every 16 ms).
   Camera motion is simulated at *render* time
   (`packages/compositor/src/camera.ts` `computeCameraTrack`: per-group
   targets, `LEAD_MS = 440` anticipation, spring). Nothing relates their
   timing, direction, or velocity profiles.
2. **Opposite-motion compounding.** Because the camera *anticipates* (target
   flips up to 440 ms before a group starts), it frequently pans against the
   cursor's travel. Apparent screen velocity ≈ cursor velocity + camera
   velocity, further multiplied by zoom (~1.5×) and the card layout upscale
   (~1.31× for a 1280×800 recording on the 1080p canvas). That is the ~12 s
   whip.
3. **Parked cursor + moving camera = drift.** After a click, `moveCursor`
   stops sampling; the cursor is stationary in content space while the camera
   glides through the nav gap (`buildShots` clamps `focusEnd` to the nav, then
   the far-gap "dome" in `targetAt` pans across it). Projected through the
   moving camera, the stationary cursor slides aimlessly over a blank page.
   The existing speed-gated fade (`Demo.tsx` `CURSOR_FADE_*`, floor 0.45)
   only half-hides it.
4. **The establish "dome" fires for same-page overlay transitions.** Button →
   dialog exceeds `panThreshold`, so the camera pulls back and re-punches with
   an underdamped spring (`damping: 0.92`) — the dialog wobble.
5. **Cursor renders above the intro cover.** `CursorLayer` is a sibling drawn
   over `VideoLayer`, whose intro cover only hides the video — hence the
   cursor-on-black cold open (`packages/compositor/src/Demo.tsx`).
6. **Non-determinism.** `dwell()` in `mouse.ts` uses unseeded `Math.random()`,
   contradicting the determinism promise in `player.ts`'s doc comment.

## 3. Decided design

One render-time **motion plan** becomes the shared source of truth for both
the visible cursor and the camera. The recorded Playwright pointer still moves
during capture (hover states must fire), but the *drawn* cursor's
between-action travels are synthesized in the compositor.

Decisions (owner-approved):

1. **Hybrid cursor ownership** — recorded samples stay authoritative *within*
   actions (typing, clicks, scrolls; click points stay pixel-exact);
   between-action travels are synthesized.
2. **Follow-cam choreography** — the cursor departs; the camera retargets
   ~120 ms later and glides the *same* direction, settling during the
   pre-action dwell. Never anticipate against the cursor.
3. **Direct pan for all same-page transitions** — the establishing pull-back
   dome is removed; `panThreshold` becomes inert (kept in the schema,
   documented as deprecated).
4. **Navigation beats** — on a `navigate` event the camera eases to a calm
   establish framing (scale `max(establishLevel, 1)`, centered) and **holds**
   there until the next travel departs. No gliding over blank pages.
5. **Cursor visibility** — hidden until first content (tied to the intro
   cover), and an **idle fade**: fade out only after **2000 ms** of stillness
   (the intended ~1 s action spacing keeps the cursor visible), fade back in
   just before its next travel departs. The camera-speed fade
   (`CURSOR_FADE_*`) is removed — follow-cam makes it obsolete.
6. **Travel character** — minimum-jerk velocity profile along a subtly bowed
   arc, targeting **~850 apparent px/s** on the 1080p canvas.
7. **Ending** — compositor extends the composition ~1.2 s by freezing the
   final video frame while the camera rests at the landing framing, then a
   500 ms fade.
8. **Determinism** — seeded dwell jitter; plan computation is pure.

### Tuning constants (single place, exported for tests)

| Constant | Value | Meaning |
| --- | --- | --- |
| `APPARENT_SPEED_PX_S` | 850 | target cursor speed in canvas px/s, measured after the follow-cam is subtracted |
| `TRAVEL_MIN_MS` / `TRAVEL_MAX_MS` | 420 / 1600 | clamp on synthesized travel duration |
| `TRAVEL_GAP_MARGIN_MS` | 60 | min gap kept between the previous action's end and a travel's departure |
| `FOLLOW_LAG_MS` | 120 | camera retarget delay after cursor departure |
| `ARC_BOW` | 0.025 × travel length, capped at 28 video px | perpendicular bow of the arc |
| `IDLE_FADE_AFTER_MS` | 2000 | stillness before the cursor fades out |
| `IDLE_FADE_MS` / `PRE_TRAVEL_FADEIN_MS` | 260 / 150 | fade-out length / how long before departure the fade-in completes |
| `OUTRO_HOLD_MS` / `OUTRO_FADE_MS` | 1200 / 500 | freeze-hold past the recording / final fade |

## 4. The motion-plan model, precisely

### 4.1 New module: `packages/compositor/src/motionPlan.ts`

```ts
export interface TravelBeat {
  kind: "travel";
  tDepart: number;          // ms (timeline time) — visible cursor leaves `from`
  tArrive: number;          // ms — lands on `to`; equals the RECORDED arrival time
  from: Vec;                // video-space position (== recorded position at tDepart)
  to: Vec;                  // video-space position (== next action's point)
  bow: Vec;                 // perpendicular arc offset vector at the path midpoint
  toShot: number | null;    // index of the shot this travel enters (null if same shot)
}
export interface HoldBeat { kind: "hold"; t0: number; t1: number; at: Vec }
export interface NavBeat  { kind: "nav";  t0: number; t1: number }  // camera establish-hold
export interface MotionPlan {
  travels: TravelBeat[];    // sorted by tDepart, non-overlapping
  holds: HoldBeat[];        // the parked windows between/after actions
  navs: NavBeat[];          // one per navigate that separates two shots
  shots: PlannedShot[];     // camera shot windows (see 4.3)
  contentStartMs: number;
  idleFades: Array<{ fadeOutAt: number; fadeInAt: number }>; // precomputed from holds
}
export function buildMotionPlan(timeline: Timeline, fps: number): MotionPlan
```

Construction (`buildMotionPlan`):

1. Reuse `buildActionGroups(timeline, cfg.groupGapMs)` from `groups.ts` —
   groups and explicit `group` markers keep their exact semantics — and
   `actionItems()` for the flat, time-sorted action list.
2. **For each consecutive action pair (prev → next)** where
   `|next.point − prevEndPoint| ≥ 4 px`:
   - `tArrive` = the time of the first recorded cursor sample in
     `(prev.end, next.start]` whose position is within 2 px of `next.point`
     (that is `moveCursor`'s final sample — it lands exactly on the target).
     Fallback if not found (older timelines): `next.start − 200`.
   - Screen distance: project `from` and `to` through the **destination
     shot's target transform** (`cameraTransform({scale: shot.level, focus:
     shot.anchor})`) and multiply by the card layout scale
     (`cardLayout(...).scale`). This is deterministic (no spring sampling).
   - `duration = clamp(screenDist / APPARENT_SPEED_PX_S × 1000, TRAVEL_MIN_MS,
     TRAVEL_MAX_MS)`, further capped to
     `tArrive − prev.end − TRAVEL_GAP_MARGIN_MS`.
   - `tDepart = tArrive − duration`.
   - `bow`: perpendicular to `to − from`, length `min(0.025·|to−from|, 28)`,
     signed so the arc bows **toward the viewport center** (sign of the cross
     product of `(to−from)` with `(center−from)`; ties resolve to +1).
     Purely geometric ⇒ deterministic.
3. **Holds** fill every span not covered by a travel or an action's own
   recorded motion, anchored at the recorded position (verifiably stationary).
4. **Navs**: for each `navigate` event that falls between two shots,
   `NavBeat.t0 = nav.t`, `t1 = ` the next travel's `tDepart + FOLLOW_LAG_MS`
   (or the next shot's start if there is no travel, e.g. after a `goto`).
5. **Idle fades**: for each hold longer than `IDLE_FADE_AFTER_MS`, emit
   `{ fadeOutAt: t0 + IDLE_FADE_AFTER_MS, fadeInAt: nextTravel.tDepart −
   PRE_TRAVEL_FADEIN_MS }`.

### 4.2 Cursor sampling: `plannedCursorAt` in `packages/compositor/src/interp.ts`

```ts
export function plannedCursorAt(plan: MotionPlan, samples: CursorSample[], tMs: number): Vec
```

- Inside a `TravelBeat`: `u = (t − tDepart)/(tArrive − tDepart)`,
  `s = minJerk(u) = 6u⁵ − 15u⁴ + 10u³`, position =
  `lerp(from, to, s) + bow · sin(π·s)`.
- Inside a `HoldBeat`: the hold anchor (exactly).
- Otherwise (inside an action's own span): existing `cursorAt` over the
  recorded samples — unchanged Catmull-Rom, so typing/click nuance survives.
- Continuity: travel endpoints coincide with recorded samples by
  construction, so the composite path is C0 everywhere and C1 in practice
  (min-jerk starts/ends at zero velocity).

`cursorAt` stays exported (fallback when a timeline predates geometry data,
and for `groups.ts`).

### 4.3 Camera: rewrite shot windows in `packages/compositor/src/camera.ts`

Replace `buildShots` + `classifyGaps` + the dome branch of `targetAt` with
plan-derived windows:

- `PlannedShot` = `{ anchor, level, focusStart, focusEnd }` where
  - `focusStart` = the entering travel's `tDepart + FOLLOW_LAG_MS`; if the
    shot has no entering travel (first shot, or first action after a `goto`),
    keep today's behavior: `group.tStart − LEAD_MS`, clamped to the last nav.
  - `focusEnd` = the exiting travel's `tDepart + FOLLOW_LAG_MS`, or the nav
    `t` if a navigation ends the shot, or `tEnd + TAIL_MS` for the final shot.
  - Consecutive same-page shot windows **abut** (previous `focusEnd` == next
    `focusStart`): the spring supplies the glide; because the target flips
    when the cursor departs, camera motion is always *toward* where the
    cursor is going — follow-cam by construction.
- `targetAt(t)`:
  1. inside a `NavBeat` → `{ scale: max(cfg.establishLevel, 1), focus:
     viewport center }` (the calm establish-hold);
  2. inside a shot window → that shot's anchor/level (unchanged);
  3. after the last shot → `OUTRO_REST` landing (unchanged);
  4. before the first shot → wide (unchanged).
- Delete `ESTABLISH_DROP`, `GAP_MIN_MS`, the `Gap` type, and the dome branch.
  `panThreshold` is no longer read: keep accepting it in `ZoomConfig` but mark
  it deprecated (see §6 on schema/docs).
- `computeCameraTrack(timeline, fps)` gains a `plan` parameter (or builds the
  plan itself and returns it alongside the track) so `Demo.tsx` computes the
  plan **once**: `const { track, plan } = computeCameraMotion(timeline, fps)`.
  Spring integration itself is untouched (knobs `stiffness`, `damping`,
  `minZoom`, `maxZoom`, `establishLevel`, `groupGapMs`, `cursorScale` all keep
  their meaning).

### 4.4 Rendering: `packages/compositor/src/Demo.tsx`

- `CursorLayer` uses `plannedCursorAt(plan, timeline.cursor, tMs)`.
- **Visibility** = product of:
  - content gate: 0 before `contentStartMs + 100`, quick 200 ms fade-in with
    the existing intro-cover reveal;
  - idle fade: from `plan.idleFades` (smoothstep over `IDLE_FADE_MS`,
    back to 1 by `fadeInAt`);
  - delete the camera-speed fade (`CURSOR_FADE_SPEED_LO/HI`,
    `CURSOR_FADE_MIN`). Keep the speed-gated smear blur (it now rarely
    triggers, by design).
- **Ending**: introduce `outputDurationMs = timeline.durationMs +
  OUTRO_HOLD_MS` —
  - `Root.tsx` `calculateMetadata`: `durationInFrames` from
    `outputDurationMs`;
  - wrap `OffthreadVideo` in Remotion's `<Freeze
    frame={lastVideoFrame} active={tMs >= timeline.durationMs}>` so the tail
    holds the final frame;
  - outro fade in `VideoLayer` re-anchored to `outputDurationMs` with
    `OUTRO_FADE_MS = 500`;
  - `packages/compositor/src/audio.ts` `renderMixToFile` (and its
    `nSamples` at audio.ts:208) must use the same `outputDurationMs` so
    music/voiceover pad and fade over the held frame, and
    `packages/compositor/src/render.ts` passes it through.

### 4.5 Recorder (small, non-breaking): `packages/core/src`

- `engines/mouse.ts` `dwell()`: accept an injected PRNG; `player.ts` creates
  one per run seeded from a stable hash of the script name (mulberry32 is
  fine, ~10 lines, no dependency). Same script ⇒ same dwell rhythm.
  (`moveCursor`'s wall-clock sampling stays — its samples no longer drive the
  visible travels, so its jitter stops mattering.)
- No changes to pacing defaults, `moveCursor` math, or capture. Old
  recordings re-render with all of the §4.1–4.4 improvements.

## 5. Ordered implementation steps

1. **`motionPlan.ts`**: types + `buildMotionPlan` (§4.1), with exported
   constants. Pure function of `(timeline, fps)`.
2. **`interp.ts`**: add `minJerk`, `plannedCursorAt` (§4.2). No behavior
   change for existing exports.
3. **`camera.ts`**: replace `buildShots`/`classifyGaps`/dome with
   plan-derived windows + `NavBeat` establish-holds (§4.3). Update the
   header comment block — it documents the old near/far model.
4. **`Demo.tsx` + `Root.tsx` + `audio.ts` + `render.ts`**: plan-driven cursor
   layer, visibility model, freeze-hold ending (§4.4).
5. **`mouse.ts` + `player.ts`**: seeded dwell (§4.5).
6. **Tests** (§7) — update `packages/compositor/test/camera.test.ts`
   expectations (dome assertions go away), add `motionPlan.test.ts`.
7. **Docs**: update `docs/ARCHITECTURE.md`'s camera/cursor section; mark
   `panThreshold` deprecated in `packages/core/src/schema.ts`'s zoom object
   (description only) and run **`pnpm generate:skill-docs`**, committing the
   regenerated skill files (CLAUDE.md rule — the skill is generated from the
   schema and must not drift).
8. **End-to-end verify** (§8), iterate on constants only if a check fails.

## 6. Compatibility notes

- `timeline.json` format: unchanged. Older timelines without `bbox`/`x,y`
  geometry fall back to recorded-sample travels (the `tArrive` fallback), so
  nothing breaks.
- Schema: no field added or removed; `panThreshold` stays parseable but
  documented as inert. Skill docs regenerated (step 7).
- `group` markers and the heuristic grouping are untouched inputs to the plan.

## 7. Motion-metric tests (`packages/compositor/test/motionPlan.test.ts`)

Fixture: a hand-written timeline mirroring first-demo's shape (two pages, one
`navigate` between them, a 3-action explicit group, a 2-shot dialog sequence,
realistic timings; check it in as `test/fixtures/signup-flow.timeline.json`).
Sample the composed motion (plan + `computeCameraTrack` + `plannedCursorAt` +
`cameraTransform`) at the render fps and assert:

1. **Apparent speed cap**: for every frame inside a travel, the screen-space
   cursor speed (projected through the sampled camera, × layout scale) is
   ≤ 1000 px/s (850 target + spring tolerance).
2. **No opposite motion**: whenever both camera and cursor screen velocities
   exceed 40 px/s, their dot product is ≥ 0.
3. **Nav stillness**: within every `NavBeat`, the planned cursor's
   content-space displacement is 0 and, from `t0 + 900 ms`, camera speed
   (`cameraSpeedAt`) is < 0.5 px/frame (the establish-hold actually holds).
4. **Click accuracy**: `plannedCursorAt(t_click)` equals each click event's
   `(x, y)` exactly.
5. **Idle fade**: a hold shorter than 2 s produces no fade entry; a 3 s hold
   produces one, with `fadeInAt` before the next `tDepart`.
6. **Determinism**: `buildMotionPlan` twice ⇒ deep-equal; two `dwell`
   sequences from the same seed ⇒ identical.
7. **Ending**: `outputDurationMs` extends the composition; camera state at
   the final frame equals the `OUTRO_REST` landing.

Also update `camera.test.ts` (dome expectations removed, establish-hold
covered) and keep everything green under `pnpm test`.

## 8. End-to-end verification

```bash
pnpm build && pnpm test
pnpm seed-app                     # terminal 1 — serves http://localhost:4321
pnpm render:example               # terminal 2 — re-records + renders first-demo.yaml
```

Then extract frames from the output MP4 (ffmpeg) and check each trouble spot
against pass criteria:

| Window | Extract | Pass criteria |
| --- | --- | --- |
| 0 → first content | 10 fps | No cursor visible on the black card; cursor appears with (or after) the form reveal. |
| Create-account click → dashboard settle | 30 fps | Cursor stays pinned on the button through the click; after the nav blank, camera is at the establish framing and *not* gliding; cursor does not drift (parked, still visible — gap < 2 s); next travel departs smoothly toward *New Project*. |
| Button → dialog travel (was ~11.5 s) | 30 fps | One continuous arc, ≥ ~1 s apparent duration, camera easing the *same* direction slightly behind; no dialog wobble/pull-back bounce. |
| Dialog Create → project page | 30 fps | Same establish-hold pattern; app spinner period reads as a calm intentional beat. |
| Ending | 10 fps | Final page holds ≥ ~2 s total (recorded tail + 1.2 s freeze), camera at rest, 500 ms fade. |

Frame-dump one-liner (per window):
`ffmpeg -ss <start> -t <len> -i out.mp4 -vf "fps=30,scale=640:360,drawtext=text='%{pts\:hms}':x=8:y=8:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.6" f%03d.png`

Finally, re-render an **existing** timeline.json (pre-change recording) to
confirm the render-only path improves without re-recording.

## 9. Out of scope (deliberately)

- The app-side blank flash during SPA navigation (seed-app behavior; a
  skeleton/loading state in the app would soften it, but the compositor now
  treats the gap as an intentional beat).
- Narration/voiceover timing (no issue observed).
- The opt-in `motionBlur: "sampled"` path — it inherits the new cursor
  position automatically; no special work.
