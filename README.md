<div align="center">

# 🎬 DemoPilot

### Turn a prompt into a polished product demo video.

**DemoPilot is an [MCP](https://modelcontextprotocol.io) server that lets an AI assistant plan a product demo, drive your app with realistic clicks and typing, and render a clean, editor-ready MP4 — reproducibly.**

[![License: MIT](https://img.shields.io/badge/License-MIT-6d5efc.svg)](./LICENSE)
[![Built with Playwright](https://img.shields.io/badge/capture-Playwright-2EAD33.svg)](https://playwright.dev)
[![Composited with Remotion](https://img.shields.io/badge/composite-Remotion-0b84f3.svg)](https://remotion.dev)
[![MCP](https://img.shields.io/badge/protocol-MCP-000000.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org)

</div>

---

## Why DemoPilot

Recording product demos by hand is tedious and brittle: you fumble the cursor, mistype, and re-record five times. DemoPilot turns the demo into a **reproducible script** that an AI authors with you, then renders on demand — so when your UI changes, you re-render instead of re-record.

The output is a clean H.264 MP4 with a smooth composited cursor, click ripples, and subtle zoom — and it imports straight into [Screen Studio](https://screen.studio) or any editor for final polish.

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
3. **Render** *(deterministic)* — replay the script with human-like pacing, capture a **cursor-less** recording plus a synchronized event **timeline**, then composite the cursor, click ripples, and zoom in [Remotion](https://remotion.dev).

Because Playwright never paints a cursor, capture is naturally clean — so the cursor is **redrawn in post** and stays fully restylable.

## Quick start

> Requires **Node ≥ 20** and **pnpm**. Remotion bundles its own ffmpeg — no system ffmpeg needed.

```bash
pnpm install
pnpm exec playwright install chromium   # one-time browser download

# Render the bundled example end-to-end (serves a seed app, replays, composites):
pnpm render:example
# → renders/first-demo.mp4
```

### Use it as an MCP server

Add DemoPilot to any MCP-capable client (Claude Desktop, etc.):

```jsonc
{
  "mcpServers": {
    "demopilot": {
      "command": "pnpm",
      "args": ["--filter", "@demopilot/mcp-server", "start"],
      "cwd": "/path/to/DemoPilot"
    }
  }
}
```

Then ask your assistant: *“Use DemoPilot to record a demo of signing up and creating a project at http://localhost:4321.”* It will drive the `author_demo` workflow and hand back an MP4 path.

## MCP surface

| Tool | What it does |
| --- | --- |
| `open_app` | Launch a browser session against a URL; returns the accessibility tree + screenshot. |
| `snapshot` | Re-read the current page so the assistant can pick targets. |
| `act` | Perform **one** step against the live page and append it to the working script. |
| `add_narration` | Add a caption/narration line at the current moment. |
| `save_demo` | Persist the working script as reusable YAML. |
| `render_demo` | Replay → clean capture → Remotion composite → **MP4** (+ `timeline.json`). |
| `list_demos` / `get_demo` | Browse saved scripts. |

**Resources:** `demo://schema` (the JSON Schema), `demo://scripts/{name}`, `demo://renders/{name}`.
**Prompt:** `author_demo` — the guided authoring loop.

## The demo script format

Targets are **accessibility-first** (`role` + `name`), which survives markup churn far better than CSS:

```yaml
name: Sign up and create your first project
baseUrl: http://localhost:4321
viewport: { width: 1280, height: 800 }
defaults: { typeCadence: human, mousePace: natural }
steps:
  - goto: /
  - narrate: First, create your account
  - type:  { target: { role: textbox, name: Email }, text: demo@acme.com }
  - type:  { target: { role: textbox, name: Password }, text: hunter2demo }
  - click: { target: { role: button, name: Create account } }
  - waitFor: { target: { text: Welcome to Acme } }
```

Step kinds: `goto · click · type · press · hover · scroll · waitFor · select · pause · narrate`.

## Project layout

```
packages/
  core/         demo-script schema, deterministic player, mouse/typing engines, capture, timeline
  compositor/   Remotion project — redraws cursor, click ripples, zoom, captions → MP4
  mcp-server/   MCP tools, resources, and the author_demo prompt
examples/
  seed-app/     a tiny static app to demo against
  scripts/      a sample demo script
```

## Roadmap

- [ ] Higher-fidelity capture via CDP `Page.startScreencast` (precise framerate)
- [ ] Voiceover / TTS narration synced to captions
- [ ] Storyboarded multi-zoom and B-roll transitions
- [ ] `storageState` recipes for authenticated demos
- [ ] Container image based on the official Playwright image

## Caveats

DemoPilot targets apps you control (staging or seeded data). Reproducibility is only as stable as the app — role/name targeting and explicit `waitFor` steps help, but a demo run against changing live data won't be bit-for-bit identical. Run against a seeded environment for best results.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## License

[MIT](./LICENSE) © DemoPilot contributors
