# OpenScreen export

DemoPilot can export a demo as an **editable [OpenScreen](https://github.com/getopenscreen/openscreen)
project** instead of a flat MP4. Where `render_demo` bakes the cursor, zoom, and
captions into pixels, `render_demo_openscreen` writes them as OpenScreen's own
editable tracks, so the user can reopen the result and hand-tune the zooms
DemoPilot suggested — exactly as if they had recorded and placed them by hand.

This works because DemoPilot and OpenScreen share the same decomposition:

```
flat cursor-less screen recording  +  cursor path over time  +  zoom regions over time
```

DemoPilot already holds all three during rendering (`capture.ts` → the clean
recording, `timeline.ts` → the cursor path + events, `compositor/motionPlan.ts` →
the zoom shots). The exporter just serializes them into OpenScreen's on-disk
format rather than compositing them.

## What lands on disk

An OpenScreen "recording" is three co-located files. `writeOpenScreenProject`
emits all three into one folder:

| File | Contents |
| --- | --- |
| `<name>.mp4` | the clean (cursor-less) screen recording, copied in verbatim |
| `<name>.mp4.cursor.json` | cursor telemetry — `{version:2, samples:[{timeMs, cx, cy, interactionType…}]}` (clicks marked) |
| `<name>.openscreen` | the project JSON — `zoomRegions`, `annotationRegions` (captions), settings |

The `.openscreen` file is plain JSON (`PROJECT_VERSION = 2`) with no signature or
checksum. On open, OpenScreen trusts any `media.screenVideoPath` inside the
project file's own directory, so **keeping the three files together is all that's
required** — no changes to OpenScreen's code.

## Usage

MCP tool: **`render_demo_openscreen`** (named saved demo, inline script, or active
session). It replays the script, captures the clean recording, and writes the
project folder under `renders/<id>/openscreen/`.

```jsonc
// -> renders/signup/openscreen/signup.openscreen (+ .mp4, + .mp4.cursor.json)
{ "name": "signup" }
```

## Verifying on a Mac (manual)

The converter is validated headlessly against OpenScreen's own
`validateProjectData` / `normalizeProjectEditor` (see "Format pinning"), but the
final visual check needs the app:

1. Export a demo with `render_demo_openscreen`.
2. Copy the whole `openscreen/` folder to the Mac (keep the three files together).
3. In OpenScreen: **File → Open Project → select the `.openscreen` file.**
4. The recording opens with the suggested zooms already on the timeline as
   editable keyframes, the cursor rendered from telemetry, and narration as text
   captions. Drag a zoom region to confirm it behaves like a hand-placed one.

## Mapping & fidelity

| DemoPilot | OpenScreen | Notes |
| --- | --- | --- |
| `PlannedShot {anchor, level, focusStart, focusEnd}` | `ZoomRegion {focus, depth, startMs, endMs, source:"manual"}` | one shot → one editable zoom region |
| `Timeline.cursor` + click events | `.cursor.json` samples (`interactionType:"click"` marked) | rendered as OpenScreen's editable-overlay cursor |
| `narrate` events | `annotationRegions` (text, lower third) | plain editable captions, no audio needed |

Deliberate choices:

- **`autoZoomEnabled: false`** and **`source: "manual"`** so OpenScreen never
  recomputes its own auto-zoom over DemoPilot's suggestions — the zooms you see
  are the ones DemoPilot placed.
- **Zoom magnification is approximate.** OpenScreen's persistence normalizer keeps
  a region's discrete `depth` preset but drops any continuous `customScale`, so a
  shot's exact magnification snaps to the nearest of OpenScreen's six depth
  presets on reopen. The region's **timing and focus point are exact**; the depth
  is the closest preset. (We still write `customScale` too — harmless today, exact
  if a build preserves it.) DemoPilot also frames the recording in a padded card
  and magnifies that, so absolute scale is a starting point to hand-tune, not a
  pixel match.
- **Cursor mode is `editable-overlay`**, so OpenScreen draws the cursor from the
  telemetry (re-themeable), matching DemoPilot's own cursor-from-timeline model.
- **Polished general-settings defaults** (`OS_DEFAULT_APPEARANCE`) are baked in so
  a demo looks finished on first open — all still editable in OpenScreen:

  | Field | Value | Effect |
  | --- | --- | --- |
  | `showBlur` | `true` | blurred background |
  | `wallpaper` | `/wallpapers/wallpaper12.jpg` | the OpenScreen built-in the blur applies to |
  | `padding` | `50` | floats the video so background/shadow/rounding show |
  | `borderRadius` | `4` | rounded edges |
  | `shadowIntensity` | `0.2` | subtle drop shadow |
  | `motionBlurAmount` | `0.08` | a touch of motion blur |

  These are type-checked by `normalizeProjectEditor`, which falls back to
  OpenScreen's own default for any field an unfamiliar build doesn't recognize.
  **Cursor size is intentionally not set** — it isn't a persisted project field at
  this OpenScreen version (`DEFAULT_CURSOR_SIZE` is a render-time constant), so it
  stays an OpenScreen app-level preference.

## Format pinning

The exporter targets OpenScreen **`PROJECT_VERSION = 2`** at commit
`getopenscreen/openscreen@b67811f`. The on-disk shapes it writes are mirrored
from:

- `src/components/video-editor/types.ts` — `ZoomRegion`, `AnnotationRegion`, `ZOOM_DEPTH_SCALES`
- `src/components/video-editor/projectPersistence.ts` — `EditorProjectData`, `normalizeProjectEditor`
- `src/lib/recordingSession.ts` — `ProjectMedia`, `cursorCaptureMode`
- `electron/ipc/handlers.ts` — the `${videoPath}.cursor.json` sidecar (`CURSOR_TELEMETRY_VERSION = 2`)

To guard against format drift in a newer OpenScreen, run the exporter's output
through OpenScreen's *own* `validateProjectData` + `normalizeProjectEditor` (clone
OpenScreen, drop a `.openscreen` next to `projectPersistence.ts` in a test, assert
the zoom regions survive). If a future OpenScreen bumps the version or reshapes a
track, that check fails loudly instead of producing a silently-broken export.
