<div align="center">

# 🎬 DemoPilot

### Turn a prompt into a polished product demo video.

**DemoPilot is an [MCP](https://modelcontextprotocol.io) server that lets an AI assistant plan a product demo, drive your app with realistic clicks and typing, and render a clean, editor-ready MP4 — reproducibly.**

[![License: MIT](https://img.shields.io/badge/License-MIT-6d5efc.svg)](./LICENSE)
[![Built with Playwright](https://img.shields.io/badge/capture-Playwright-2EAD33.svg)](https://playwright.dev)
[![Composited with Remotion](https://img.shields.io/badge/composite-Remotion-0b84f3.svg)](https://remotion.dev)
[![MCP](https://img.shields.io/badge/protocol-MCP-000000.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org)

<br />

<a href="./docs/media/first-demo.mp4"><img src="./docs/media/first-demo.gif" alt="DemoPilot rendering a sign-up-and-create-project demo: cursor glides through the form, click ripples, and a smooth follow-cam zoom" width="720" /></a>

<sub><em>An actual DemoPilot render — composited cursor, click ripples, and follow-cam zoom.</em></sub>

</div>

---

## Why DemoPilot

Recording product demos by hand is tedious and brittle: you fumble the cursor, mistype, and re-record five times. DemoPilot turns the demo into a **reproducible script** that an AI authors with you, then renders on demand — so when your UI changes, you re-render instead of re-record.

The output is a clean H.264 MP4 with a smooth composited cursor, click ripples, and subtle zoom — and it imports straight into [Screen Studio](https://screen.studio) or any editor for final polish. Prefer to keep editing? Export the same demo as an **editable [OpenScreen](https://github.com/getopenscreen/openscreen) project** and hand-tune every zoom as a real keyframe (see [below](#export-to-openscreen-editable-project)).

```
   "Show signing up and creating a first project."
                      │
            ┌─────────▼─────────┐
            │   AI + MCP tools  │   author → validate → save
            └─────────┬─────────┘
                      │  reproducible demo script (YAML)
            ┌─────────▼─────────┐
            │  deterministic    │   realistic mouse + typing
            │  replay + capture │   → clean webm + timeline.json
            └─────────┬─────────┘
                      │
            ┌─────────▼─────────┐
            │ Remotion composite│   cursor · click rings · zoom · captions
            └─────────┬─────────┘
                      │
                  demo.mp4  →  import into Screen Studio
```

## How it works

DemoPilot separates the **adaptive** part from the **deterministic** part:

1. **Author** *(AI-assisted)* — the assistant opens your app, reads the accessibility tree, and resolves robust `role` + `name` targets. Each validated action is appended to a working **demo script**.
2. **Script** *(the artifact)* — a small YAML document, validated by a schema. This is the reproducible deliverable: re-render it any time, no AI in the loop.
3. **Render** *(deterministic)* — replay the script with calm, human-like pacing, capture a **cursor-less** recording plus a synchronized event **timeline**, then composite the cursor, click ripples, zoom, captions and a Screen-Studio-style frame in [Remotion](https://remotion.dev).

Because Playwright never paints a cursor, capture is naturally clean — so the cursor is **redrawn in post** and stays fully restylable. Capture uses CDP `Page.startScreencast` for crisp, constant-frame-rate frames (with an automatic fallback to Playwright's `recordVideo`).

## Install

DemoPilot ships as a single npm package, `demopilot-mcp`, with two bins:
`demopilot-mcp` (the stdio MCP server) and `demopilot` (the render CLI). You don't
clone the monorepo to use it.

> **Prerequisites (one-time).** **Node ≥ 20** (an [`.nvmrc`](./.nvmrc) pins 20 — run
> `nvm use`). DemoPilot drives a real browser and renders with Remotion, so once:
>
> ```bash
> npx playwright install chromium   # the capture browser
> ```
>
> Remotion also needs a Chrome **Headless Shell** to render; DemoPilot reuses the
> one Playwright just installed, so the line above covers both. If it can't find
> one it downloads its own (needs network); point it at any Chrome with
> `DEMOPILOT_CHROME=/path/to/chrome`. Remotion bundles its own **ffmpeg** — no
> system ffmpeg needed.

### Add it to Claude Code — one command

**As a plugin (skill + server together).** Installs the `demopilot-demo-scripts`
authoring skill *and* the MCP server in one step:

```text
/plugin marketplace add MaverickEmanuel/DemoPilot
/plugin install demopilot@demopilot
```

**As just the MCP server** (any MCP client — Claude Code, Claude Desktop, etc.):

```bash
claude mcp add demopilot -- npx -y demopilot-mcp
```

…or paste this `.mcp.json` into your project:

```json
{
  "mcpServers": {
    "demopilot": {
      "command": "npx",
      "args": ["-y", "demopilot-mcp"]
    }
  }
}
```

Then ask your assistant: *“Use DemoPilot to record a demo of signing up and
creating a project at http://localhost:4321.”* It drives the `author_demo`
workflow and hands back an MP4 path.

### Render from the command line

The `demopilot` CLI renders any script to MP4 without an MCP client. It replays
the script against **its own `baseUrl`** — serve your app there first.

```bash
npm i -g demopilot-mcp                  # installs the `demopilot` (+ `demopilot-mcp`) bins
demopilot render demo.yaml              # → renders/demo.mp4
# no global install? run it ad-hoc:
npx -p demopilot-mcp demopilot render demo.yaml

# options: pick the output, speed it up, drop overlays:
demopilot render demo.yaml --out out/demo.mp4 --speed 1.25 --no-captions
```

| Flag | Effect |
| --- | --- |
| `-o, --out <file.mp4>` | Output path (default `renders/<script-name>.mp4`). |
| `-s, --speed <n>` | Global pace multiplier — `>1` faster, `<1` slower. |
| `--fps <n>` | Output frame rate (default 60). |
| `--background <b>` | Background preset or a raw CSS background string. |
| `--music <bed>` | Music bed: `calm` (default), `warm`, or `none`. |
| `--music-volume <n>` | Music bed volume `0..1` (default `0.16`). |
| `--no-sfx` | Drop the subtle click ticks. |
| `--voiceover` | TTS voiceover for narration (needs `OPENAI_API_KEY` or `ELEVENLABS_API_KEY`). |
| `--no-zoom` / `--no-captions` / `--no-frame` | Drop the zoom, captions, or the framed presentation. |
| `--headed` | Run the capture browser headed (default headless). |

Renders ship with a soft, license-clear **music bed + subtle click ticks by
default** (synthesized — no assets, no external service), muxed on with Remotion's
bundled ffmpeg. **Voiceover** is opt-in: set `OPENAI_API_KEY` (or
`ELEVENLABS_API_KEY`) and pass `--voiceover` to narrate each `narrate` line and
duck the music under speech; with no key it's skipped silently and the on-screen
captions remain.

The MP4 path is printed to **stdout** (logs go to stderr), so it composes in
scripts: `OUT=$(demopilot render demo.yaml)`. A `.timeline.json` sidecar is written
next to the output.

## Run from source (contributors)

Working on DemoPilot itself? Use the monorepo directly — no publish step:

```bash
pnpm install
pnpm exec playwright install chromium   # one-time browser download

# Render the bundled example end-to-end (serves a seed app, replays, composites):
pnpm render:example                      # → renders/first-demo.mp4

# Or the CLI / MCP server straight from source:
pnpm seed-app                            # serve the seed app on :4321 (one terminal)
pnpm demopilot render examples/scripts/first-demo.yaml   # (another terminal)
pnpm mcp                                 # the stdio MCP server

# Assemble + pack the publishable npm package (→ dist-package/, demopilot-mcp-*.tgz):
pnpm pack:dist
```

## MCP surface

| Tool | What it does |
| --- | --- |
| `open_app` | Launch a browser session against a URL; returns the accessibility tree + screenshot. |
| `snapshot` | Re-read the current page so the assistant can pick targets. |
| `act` | Perform **one** step against the live page and append it to the working script. |
| `add_narration` | Add a caption/narration line at the current moment. |
| `save_demo` | Persist the working script as reusable YAML. |
| `render_demo` | Replay → clean capture → Remotion composite → **MP4** (+ `timeline.json`). |
| `render_demo_openscreen` | Replay → clean capture → **editable [OpenScreen](https://github.com/getopenscreen/openscreen) project** (zoom + caption tracks as real keyframes, not baked footage). |
| `list_demos` / `get_demo` | Browse saved scripts. |

**Resources:** `demo://schema` (the JSON Schema), `demo://scripts/{name}`, `demo://renders/{name}`.
**Prompt:** `author_demo` — the guided authoring loop.

## Export to OpenScreen (editable project)

`render_demo` bakes the cursor, zoom, click ripples, and frame into a finished
MP4. `render_demo_openscreen` does the opposite: it hands you the **clean screen
recording** plus DemoPilot's suggestions as **editable
[OpenScreen](https://github.com/getopenscreen/openscreen) tracks** — so you can
reopen the project and hand-tune every zoom as a real keyframe instead of
re-rendering.

It writes a self-contained project folder (keep the three files together —
OpenScreen resolves the video relative to the project):

```
<name>.openscreen        project — zoom + caption tracks, settings
<name>.mp4               the CLEAN recording — no zoom, ripples, or padding baked into the pixels
<name>.mp4.cursor.json   cursor telemetry (samples + click markers)
```

Open it in OpenScreen via **File → Open Project**. The zooms DemoPilot planned
arrive as editable keyframes, and click ripples are drawn by OpenScreen from the
cursor telemetry — **nothing is baked into the footage.** The project also ships
polished-but-editable general settings so a demo looks finished on first open: a
blurred background, padding, rounded corners, a subtle shadow, and a touch of
motion blur. The exporter probes the video and refuses a composited render, so
only the clean capture is ever imported. Format is pinned to OpenScreen
`PROJECT_VERSION 2`; see [docs/openscreen-export.md](./docs/openscreen-export.md)
for the full mapping and fidelity notes.

## The demo script format

Targets are **accessibility-first** (`role` + `name`), which survives markup churn far better than CSS:

```yaml
name: Sign up and create your first project
baseUrl: http://localhost:4321
viewport: { width: 1280, height: 800 }
defaults: { typeCadence: human, mousePace: natural, zoom: { level: 1.25 } }
steps:
  - goto: /
  - narrate: First, create your account
  - zoom: in        # hold one sustained zoom across the whole login…
  - type:  { target: { role: textbox, name: Email }, text: demo@acme.com }
  - type:  { target: { role: textbox, name: Password }, text: hunter2demo }
  - click: { target: { role: button, name: Create account } }
  - zoom: out        # …and release it after submit
  - waitFor: { target: { text: Welcome to Acme } }
```

Step kinds: `goto · click · type · press · hover · scroll · waitFor · select · pause · narrate · zoom`.

The compositor zooms automatically toward whatever's being acted on. A run of
nearby fields (like a login) holds **one** sustained, steady zoom anchored on the
form, while each important button click gets its own slightly deeper zoom
centered on the button. `defaults.zoom.level` sets the base magnification
(default `1.25`, `1` disables) and `defaults.zoom.clickBoost` how much deeper
clicks punch in (default `0.1`); the optional `zoom: in` / `zoom: out` steps let
you force a region explicitly. The cursor itself travels at a calm, deliberate
pace (tune per demo with `defaults.mousePace` or the global `speed`).

## Project layout

```
packages/
  core/         demo-script schema, deterministic player, mouse/typing engines, capture, timeline
  compositor/   Remotion project — redraws cursor, click ripples, zoom, captions → MP4
  mcp-server/   MCP tools, resources, the author_demo prompt, and the demopilot / demopilot-mcp bins
examples/
  seed-app/     a tiny static app to demo against
  scripts/      a sample demo script
scripts/
  build-dist.mjs   assembles the published `demopilot-mcp` package (→ dist-package/)
.claude-plugin/   Claude Code plugin manifest + marketplace (bundles the skill + MCP server)
.claude/skills/   the demopilot-demo-scripts authoring skill
```

## Roadmap

- [x] Higher-fidelity capture via CDP `Page.startScreencast` (constant framerate, crisper text)
- [x] Audio: synthesized music bed + click ticks by default; opt-in TTS voiceover
- [ ] Storyboarded multi-zoom and B-roll transitions
- [ ] `storageState` recipes for authenticated demos
- [ ] Container image based on the official Playwright image

## Caveats

DemoPilot targets apps you control (staging or seeded data). Reproducibility is only as stable as the app — role/name targeting and explicit `waitFor` steps help, but a demo run against changing live data won't be bit-for-bit identical. Run against a seeded environment for best results.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## License

[MIT](./LICENSE) © DemoPilot contributors
