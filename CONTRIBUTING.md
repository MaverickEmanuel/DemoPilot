# Contributing to DemoPilot

Thanks for your interest! DemoPilot is an early-stage open-source project and
contributions are welcome.

## Development setup

```bash
pnpm install
pnpm exec playwright install chromium
```

## Common commands

| Command | What it does |
| --- | --- |
| `pnpm typecheck` | Type-check every package. |
| `pnpm test` | Run unit tests (the player e2e test self-skips without Chromium). |
| `pnpm render:example` | Full end-to-end render of the bundled example → `renders/first-demo.mp4`. |
| `pnpm seed-app` | Serve the seed app at http://localhost:4321. |
| `pnpm mcp` | Start the MCP server on stdio. |

## Project layout

- `packages/core` — schema, player, capture, timeline (no MCP/React deps).
- `packages/compositor` — Remotion project (keeps its own timeline types).
- `packages/mcp-server` — MCP tools, resources, prompt.
- `examples/` — seed app + sample script.

## Guidelines

- Keep `core` free of MCP- and React-specific code.
- The compositor must not import `@demopilot/core` at runtime — copy the minimal
  timeline shape into `compositor/src/types.ts` so the browser bundle stays clean.
- Prefer accessibility (`role` + `name`) targeting in examples and docs.
- Add a unit test when you touch the schema, timeline, or interpolation logic.

## Submitting changes

1. Open an issue describing the change for anything non-trivial.
2. Run `pnpm typecheck && pnpm test` before pushing.
3. Keep PRs focused and include a short description of the behavior change.
