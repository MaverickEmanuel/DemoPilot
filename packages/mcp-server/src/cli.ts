#!/usr/bin/env -S npx tsx
/**
 * Standalone DemoPilot CLI — render a demo script to MP4 without an MCP client.
 *
 *   demopilot render <script.yaml> [--out <file.mp4>] [--speed <n>] [options]
 *
 * Reuses the same pipeline as the MCP `render_demo` tool: playDemo captures a
 * clean, cursor-less recording plus a timeline, then renderDemo composites the
 * cursor, click ripples, zoom, captions and framing into the final MP4. The
 * script is rendered against its own `baseUrl` (serve your app there first; the
 * bundled example targets the local seed app on http://localhost:4321).
 */
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { loadDemoScript, playDemo } from "@demopilot/core";
import { renderDemo } from "@demopilot/compositor";
import { resolveChromeForRemotion } from "./chrome.js";

interface RenderArgs {
  scriptPath: string;
  out?: string;
  speed?: number;
  fps?: number;
  zoom: boolean;
  captions: boolean;
  framed: boolean;
  headless: boolean;
}

const USAGE = `DemoPilot — render a demo script to MP4.

Usage:
  demopilot render <script.yaml> [options]

Options:
  -o, --out <file.mp4>   Output path (default: renders/<script-name>.mp4)
  -s, --speed <n>        Global pace multiplier (>1 faster, <1 slower)
      --fps <n>          Output frame rate (default 30)
      --no-zoom          Disable the subtle zoom-toward-cursor
      --no-captions      Disable narration captions
      --no-frame         Disable the framed app-card presentation (full-bleed)
      --headed           Run the capture browser headed (default: headless)
  -h, --help             Show this help

The script renders against its own baseUrl. Serve your app there first; the
bundled example expects the seed app on http://localhost:4321 (run: pnpm seed-app).

Examples:
  demopilot render examples/scripts/first-demo.yaml
  demopilot render demo.yaml --out out/demo.mp4 --speed 1.25
`;

/** Splits any `--key=value` tokens into `--key value` so both forms work. */
function normalizeArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (const tok of argv) {
    const m = /^(--[a-z-]+)=(.*)$/.exec(tok);
    if (m) out.push(m[1], m[2]);
    else out.push(tok);
  }
  return out;
}

function parseRenderArgs(argv: string[]): RenderArgs {
  const toks = normalizeArgv(argv);
  const args: RenderArgs = {
    scriptPath: "",
    zoom: true,
    captions: true,
    framed: true,
    headless: true,
  };
  const num = (label: string, v: string | undefined): number => {
    const n = Number(v);
    if (!v || Number.isNaN(n)) throw new Error(`${label} expects a number, got: ${v ?? "(missing)"}`);
    return n;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t) {
      case "-o":
      case "--out":
        args.out = toks[++i];
        break;
      case "-s":
      case "--speed":
        args.speed = num("--speed", toks[++i]);
        if (args.speed <= 0) throw new Error("--speed must be greater than 0");
        break;
      case "--fps":
        args.fps = num("--fps", toks[++i]);
        break;
      case "--no-zoom":
        args.zoom = false;
        break;
      case "--no-captions":
        args.captions = false;
        break;
      case "--no-frame":
        args.framed = false;
        break;
      case "--headed":
        args.headless = false;
        break;
      default:
        if (t.startsWith("-")) throw new Error(`Unknown option: ${t}`);
        if (args.scriptPath) throw new Error(`Unexpected extra argument: ${t}`);
        args.scriptPath = t;
    }
  }
  if (!args.scriptPath) throw new Error("Missing <script.yaml>. See --help.");
  return args;
}

async function cmdRender(argv: string[]): Promise<void> {
  const args = parseRenderArgs(argv);

  // Resolve user paths against the directory the command was invoked from. pnpm
  // sets INIT_CWD to that directory even when it runs the bin with a different
  // cwd (e.g. `pnpm --filter … cli`), so relative paths work from anywhere.
  const baseCwd = process.env.INIT_CWD ?? process.cwd();

  const script = await loadDemoScript(resolve(baseCwd, args.scriptPath));
  if (args.speed !== undefined) script.defaults.speed = args.speed;

  const name = basename(args.scriptPath).replace(/\.(ya?ml|json)$/i, "") || "demo";
  const outPath = resolve(baseCwd, args.out ?? join("renders", `${name}.mp4`));
  const timelinePath = outPath.replace(/\.mp4$/i, "") + ".timeline.json";

  const captureDir = await mkdtemp(join(tmpdir(), "demopilot-cli-"));

  console.error(`▶ Replaying ${args.scriptPath} against ${script.baseUrl} (speed ${script.defaults.speed})…`);
  const { videoPath, timeline } = await playDemo(script, { videoDir: captureDir, headless: args.headless });
  await writeFile(timelinePath, JSON.stringify(timeline, null, 2), "utf8");

  console.error(`▶ Compositing MP4…`);
  const result = await renderDemo({
    videoPath,
    timeline,
    outPath,
    fps: args.fps,
    zoomOnClick: args.zoom,
    captions: args.captions,
    framed: args.framed,
    browserExecutable: resolveChromeForRemotion(),
    onProgress: (r) => process.stderr.write(`\r  ${(r * 100).toFixed(0)}%   `),
  });
  process.stderr.write("\n");
  console.error(
    `✓ ${result.width}x${result.height} @ ${result.fps}fps, ${(result.durationMs / 1000).toFixed(1)}s` +
      `\n  timeline: ${timelinePath}`,
  );
  // The MP4 path on stdout, so callers can capture it: OUT=$(demopilot render …)
  console.log(result.outPath);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === "render") {
    await cmdRender(rest);
    return;
  }
  console.error(`Unknown command: ${cmd}\n`);
  process.stdout.write(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(`✗ ${err?.message ?? err}`);
  process.exit(1);
});
