# Architecture

DemoPilot is built around one core idea: **separate the adaptive authoring phase
from the deterministic render phase.** Authoring needs intelligence (resolving
selectors on real, dynamic UIs); rendering needs determinism (so a demo is
reproducible). The boundary between them is a small, validated **demo script**.

```
prompt ──▶ author (AI + MCP tools) ──▶ demo script (YAML) ──▶ render ──▶ MP4
                live browser, a11y          the artifact         replay + composite
```

## Packages

### `@demopilot/core`

The engine, with no MCP or React dependencies.

- **`schema.ts`** — the demo-script IR as a zod schema. Steps use a one-key
  shorthand (`{ click: { target } }`). Targets prefer accessibility
  (`role` + `name`) with CSS/test-id escape hatches. `jsonSchema.ts` exports it
  as JSON Schema for the `demo://schema` resource.
- **`player.ts`** — deterministically replays a script. Drives a *real* Playwright
  pointer (so hover/focus states fire) along eased paths, types with human
  cadence, and records everything to a timeline.
- **`engines/mouse.ts`, `engines/typing.ts`** — the "feel real" layer: eased
  movement with slight overshoot + pre-click dwell, and per-character typing
  jitter.
- **`capture.ts`** — launches Chromium and records a **clean**, cursor-less video
  (Playwright never paints a pointer). Two backends: the default **screencast**
  collects CDP `Page.startScreencast` frames (each timestamped) and assembles them
  into a constant-fps MP4 with Remotion's bundled ffmpeg — crisper text, uniform
  timing; **recordVideo** (Playwright's realtime VP8 webm) is the fallback. The
  pacing/timeline contract is identical either way.
- **`timeline.ts`** — accumulates cursor samples and discrete events (click, type,
  navigate, narrate) keyed by `t` (ms from recording start). This sidecar is how
  the compositor stays in sync with the video.

### `@demopilot/compositor`

A standalone [Remotion](https://remotion.dev) project. It deliberately keeps its
own copy of the timeline types (`types.ts`) so the browser bundler never has to
resolve the Node-only core package.

- **`motionPlan.ts`** — the **cursor–camera motion plan**: one pure function of
  `(timeline, fps)` that is the shared source of truth for both the redrawn
  cursor and the tracking camera. From the recorded action groups it derives
  *beats*: **travels** (synthesized minimum-jerk arcs between consecutive
  actions, pinned to the recorded landing sample and speed-capped to a constant
  *apparent* screen speed), **holds** (the parked windows, where the cursor is
  verifiably stationary), **navs** (establish-hold windows over navigations), and
  **shots** (per-group camera windows). Because the shot windows are derived from
  the travels, the camera *follows* the cursor — it retargets a beat after the
  cursor departs and glides the same direction, never anticipating against it.
- **`camera.ts`** — the spring-physics tracking camera. It consumes the plan's
  shots/navs: a critically-ish-damped spring chases a time-varying `{scale,
  focus}` target (adaptive depth fits each group's box into an inner safe area).
  Same-page shot windows abut, so the spring glides straight across (a direct
  follow-cam pan — there is no establishing "pull-back"); a navigation eases the
  camera to a calm centered establish framing and holds until the next travel
  departs, so it never glides over a blank page. `cameraTransform` clamps the
  applied translate+scale so the content always covers the card.
- **`interp.ts`** — `plannedCursorAt` samples the plan: a minimum-jerk arc inside
  a travel, the anchor inside a hold, and otherwise the recorded Catmull-Rom path
  (so typing/click nuance and pixel-exact click points survive). This *hybrid*
  ownership keeps recorded samples authoritative within actions and synthesizes
  only the between-action travels.
- **`Demo.tsx`** — composites `OffthreadVideo` (the clean recording) with the
  planned `Cursor`, click ripples, the camera, and optional captions. The cursor
  is hidden until the first content and fades out only after prolonged stillness
  (an idle fade), back in just before its next travel. The composition is
  extended past the recording by an outro freeze-hold (`outro.ts`): the final
  frame is frozen (`<Freeze>`) while the camera rests on its landing framing, then
  a final fade. `defaults.zoom.*` (depth, spring, `establishLevel`, `cursorScale`)
  and explicit `group`/`zoom: in/out` markers tune it; `panThreshold` and
  `clickBoost` are deprecated no-ops (the per-click punch and dome are gone).
- **`Root.tsx`** — registers the `Demo` composition; `calculateMetadata` derives
  dimensions and the (freeze-hold-extended) duration from the timeline.
- **`render.ts`** — programmatic render: stages the webm into a temp public dir,
  bundles, calls `renderMedia` (Remotion drives its own bundled ffmpeg), then
  mixes/muxes the synthesized audio track (padded to the same extended duration).

### `@demopilot/mcp-server`

The MCP entry point and orchestration.

- **`session.ts`** — a live *authoring* session. `act` executes a step quickly
  (no animation — that's for render time) and appends it to the working script;
  `snapshot` returns a compact accessibility tree + screenshot.
- **`tools.ts`** — registers the tool surface. `render_demo` ties core + compositor
  together: `playDemo` → `timeline.json` → `renderDemo` → MP4 + metadata.
- **`resources.ts` / `prompts.ts`** — the `demo://*` resources and the
  `author_demo` guided workflow.

## Why these choices

- **Accessibility-first targeting** survives markup churn far better than CSS and
  mirrors how Playwright's own snapshots work.
- **Clean capture + post-composite** (instead of baking a cursor into capture)
  keeps the cursor and zoom fully restylable and decouples capture fidelity from
  presentation.
- **Return file paths, never blobs** — multi-MB MP4s do not belong on the MCP wire.

## Known hard parts

1. **Cursor fidelity** — solved by compositing, at the cost of a Remotion render.
2. **Reproducibility** — only as stable as the app; mitigated by a11y targeting +
   explicit `waitFor` + recommending seeded/staging environments.
3. **Video/timeline sync** — time-based. The screencast backend aligns CDP frame
   timestamps to the timeline's `t=0` (anchored on the first frame) and pads static
   stretches to a constant fps, so overlay/video time stay matched (verified at
   0px overlay offset on clicks).
4. **Server rendering** — headed crispness and fonts; base CI/containers on the
   official Playwright image.

## Capture fidelity

The default **screencast** backend collects CDP `Page.startScreencast` frames
(JPEG, each with a metadata timestamp), maps those timestamps onto the timeline's
wall clock, and assembles them into a constant-fps H.264 MP4 using the ffmpeg that
Remotion bundles (resolved via `resolveBundledFfmpeg()`; no system ffmpeg). Static
screens are padded by holding the most recent frame, so timing stays uniform. This
replaces realtime VP8 encoding, so text is markedly crisper. Screencast captures at
the CSS viewport resolution (matching the 1× output), so overlay coordinates are
unchanged. The legacy `recordVideo` path remains as an automatic fallback (and an
explicit `--legacy-capture` / `DEMOPILOT_CAPTURE=recordVideo` opt-out).
