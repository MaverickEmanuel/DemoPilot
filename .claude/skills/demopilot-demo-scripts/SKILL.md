---
name: demopilot-demo-scripts
description: Author, edit, and validate DemoPilot demo video scripts (YAML) — steps, accessibility targets, action groups, zoom, narration — and run the render workflow to MP4. Use whenever creating, editing, or reviewing a DemoPilot demo script or rendering a demo.
---

# Authoring DemoPilot demo scripts

DemoPilot turns a YAML **demo script** into a reproducible product-demo video.
Authoring is adaptive (an agent drives the live app and writes the script);
rendering is deterministic (the script is replayed, captured, and composited
with cursor, zoom, and captions into an MP4). Your job in this skill is to
produce or edit a correct, robust script.

- **Format reference (authoritative, generated):**
  [`references/script-schema.md`](references/script-schema.md) — exact field
  list, types, enums, defaults, and ranges, generated from
  `packages/core/src/schema.ts`. Trust it over anything below if they disagree.
- **Copy-paste starters:** [`templates/minimal.yaml`](templates/minimal.yaml)
  and [`templates/full-with-defaults.yaml`](templates/full-with-defaults.yaml).
- **Deeper docs:** `README.md` (format overview), `docs/ARCHITECTURE.md`
  (author → script → render model), `VIDEO_POLISH.md` (camera/zoom tuning),
  `CONTRIBUTING.md` (conventions).

## Script shape (at a glance)

A script has `name`, `baseUrl`, optional `viewport`/`storageStatePath`/`defaults`,
and a non-empty `steps` array. Each **step is an object with exactly one action
key** (one-key shorthand), e.g. `- goto: /` or `- click: { target: {...} }`. The
full vocabulary — `goto`, `click`, `type`, `press`, `hover`, `scroll`, `waitFor`,
`select`, `pause`, `narrate`, `zoom`, `group` — and every field is in
`references/script-schema.md`. Start from a template; don't write from memory.

## Best practices

**1. Target elements by accessibility first.** Prefer `role` + `name` (e.g.
`{ role: button, name: Create account }`). These survive markup changes far
better than CSS. Use `css` or `testId` only as escape hatches, and `exact` /
`nth` to disambiguate. Every target needs at least one of `role`, `name`,
`text`, `css`, `testId`.

**2. Wait for async results — don't guess with `pause`.** After a navigation,
form submit, or SPA route change, add a `waitFor` keyed to something that proves
the new state arrived (`waitFor: { target: { text: Welcome to Acme } }`). This is
what makes replay reproducible. Reserve `pause` for small deliberate beats.

**3. Group related actions so the camera holds steady.** Wrap a multi-step flow
(e.g. email → password → submit) in `group: { name: Sign in }` … `group: end`.
The camera holds one anchor across the group instead of pumping between fields.
DemoPilot also auto-groups by container, but an explicit, named group is more
deliberate and reads better. Use separate groups (or none) when actions live in
genuinely different regions you want the camera to travel between.

**4. Narrate the why, sparingly.** Add `narrate` lines at key transitions to
guide the viewer ("First, create your account"). Keep them short; they become
on-screen captions.

**5. Reach for explicit `zoom` and `defaults` only when needed.** The built-in
adaptive camera is good by default. Use `zoom: in` … `zoom: out` to force a
sustained close-up over a region, and a `defaults:` block (e.g. `speed`,
`postActionHold`, `defaults.zoom.*`) to tune pacing/camera. See `VIDEO_POLISH.md`
for what each zoom parameter does. Omit `defaults` entirely to run on the
calibrated defaults.

## Authoring + render workflow (MCP)

When driving a live app via the DemoPilot MCP server, follow the `author_demo`
loop (`packages/mcp-server/src/prompts.ts`):

1. `open_app({ url, name })` — launch the app, read the accessibility tree.
2. `snapshot()` — re-read the page before picking a target.
3. `act({ step })` — perform **one** step at a time; prefer accessibility targets.
4. `add_narration({ text })` — add captions at key moments.
5. `save_demo({ name })` — persist the working YAML script.
6. `render_demo({ name })` — replay → capture → composite → MP4 + timeline.

The live JSON Schema is also available to MCP clients as `demo://schema`.

## Validate before rendering

Make sure the script parses against the schema. Quickest check from the repo:

```bash
pnpm --filter @demopilot/core exec tsx -e \
  "import {parseDemoScript} from './src/index.js'; import {readFileSync} from 'node:fs'; import {parse} from 'yaml'; parseDemoScript(parse(readFileSync(process.argv[1],'utf8'))); console.log('valid');" \
  path/to/your-demo.yaml
```

## Keeping this skill accurate

`references/script-schema.md` and `templates/*.yaml` are **generated** from the
Zod schema — do not hand-edit them. If you change the script format in
`packages/core/src/schema.ts`, regenerate:

```bash
pnpm generate:skill-docs
```

A PostToolUse hook (`.claude/hooks/sync-skill-docs.sh`) runs this automatically
when the schema is edited in a Claude Code session; other agents/humans should
run it manually and commit the result (see `CLAUDE.md`).
