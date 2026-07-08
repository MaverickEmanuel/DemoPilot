import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StepSchema, DemoScriptSchema, playDemo, type DemoScript } from "@demopilot/core";
import { renderDemo, resolveBundledFfmpeg } from "@demopilot/compositor";
import type { Timeline } from "@demopilot/core";
import { AuthoringSession } from "./session.js";
import { resolveChromeForRemotion } from "./chrome.js";
import { saveScript, loadScript, listScripts, renderDir, saveRenderMeta, type RenderMeta } from "./store.js";

/** Holds the single active authoring session (MVP supports one at a time). */
const state: { session: AuthoringSession | null } = { session: null };

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "demo";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerTools(server: McpServer): void {
  server.registerTool(
    "open_app",
    {
      title: "Open app",
      description:
        "Launch a browser session against a URL to start authoring a demo. Returns the page's accessibility tree and a screenshot so you can choose targets.",
      inputSchema: {
        url: z.string().url(),
        name: z.string().optional().describe("Name for the demo being authored"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      },
    },
    async ({ url, name, width, height }) => {
      if (state.session) await state.session.close();
      state.session = await AuthoringSession.open({
        url,
        name,
        viewport: width && height ? { width, height } : undefined,
        headless: process.env.DEMOPILOT_HEADLESS !== "false",
      });
      const snap = await state.session.snapshot();
      return {
        content: [
          { type: "text", text: `Session ${state.session.id} open at ${snap.url}\n\nAccessibility tree:\n${snap.aria}` },
          { type: "image", data: snap.screenshotBase64, mimeType: "image/png" },
        ],
      };
    },
  );

  server.registerTool(
    "snapshot",
    {
      title: "Snapshot",
      description: "Return the current accessibility tree and a screenshot of the active session.",
      inputSchema: {},
    },
    async () => {
      const session = requireSession();
      const snap = await session.snapshot();
      return {
        content: [
          { type: "text", text: `At ${snap.url}\n\nAccessibility tree:\n${snap.aria}` },
          { type: "image", data: snap.screenshotBase64, mimeType: "image/png" },
        ],
      };
    },
  );

  server.registerTool(
    "act",
    {
      title: "Act",
      description:
        "Perform a single demo step against the live page and append it to the working script. Prefer role+name targets. Returns the updated snapshot.",
      inputSchema: { step: StepSchema },
    },
    async ({ step }) => {
      const session = requireSession();
      try {
        await session.applyStep(step);
      } catch (err) {
        return text(`Step failed: ${(err as Error).message}. Not recorded — adjust the target and retry.`);
      }
      const snap = await session.snapshot();
      return {
        content: [
          { type: "text", text: `Recorded step ${session.steps.length}. Now at ${snap.url}\n\n${snap.aria}` },
          { type: "image", data: snap.screenshotBase64, mimeType: "image/png" },
        ],
      };
    },
  );

  server.registerTool(
    "add_narration",
    {
      title: "Add narration",
      description: "Append a narration/caption line at the current point in the demo.",
      inputSchema: { text: z.string() },
    },
    async ({ text: t }) => {
      const session = requireSession();
      session.addNarration(t);
      return text(`Added narration: "${t}" (step ${session.steps.length})`);
    },
  );

  server.registerTool(
    "save_demo",
    {
      title: "Save demo",
      description: "Persist the working demo script as a reusable YAML file.",
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }) => {
      const session = requireSession();
      if (name) session.setName(name);
      const script = session.toScript();
      const id = slug(name ?? script.name);
      const path = await saveScript(id, script);
      return text(`Saved demo "${id}" (${script.steps.length} steps) to ${path}\nResource: demo://scripts/${id}`);
    },
  );

  server.registerTool(
    "render_demo",
    {
      title: "Render demo",
      description:
        "Render a demo to MP4: deterministically replay the script with realistic pacing, capture a clean recording, and composite cursor/clicks/zoom. Renders the named saved demo, the inline script, or the active session.",
      inputSchema: {
        name: z.string().optional().describe("Name of a saved demo to render"),
        script: DemoScriptSchema.optional().describe("An inline demo script to render"),
        fps: z.number().int().positive().max(60).optional(),
        zoomOnClick: z.boolean().optional(),
        captions: z.boolean().optional(),
        headless: z.boolean().optional(),
        music: z.string().optional().describe("Music bed: 'calm' (default), 'warm', or 'none'"),
        musicVolume: z.number().min(0).max(1).optional().describe("Music bed volume 0..1 (default 0.16)"),
        sfx: z.boolean().optional().describe("Subtle click ticks (default true)"),
        voiceover: z
          .boolean()
          .optional()
          .describe("TTS voiceover for narrate lines (needs OPENAI_API_KEY/ELEVENLABS_API_KEY; skipped if unset)"),
      },
    },
    async ({ name, script: inline, fps, zoomOnClick, captions, headless, music, musicVolume, sfx, voiceover }) => {
      const { script, id } = await resolveScript({ name, inline });
      const dir = renderDir(id);
      await mkdir(dir, { recursive: true });

      // Prefer the crisper, constant-fps CDP screencast capture; fall back to
      // the realtime recordVideo backend if ffmpeg can't be located.
      const ffmpeg = resolveBundledFfmpeg();
      const { videoPath, timeline } = await playDemo(script, {
        videoDir: join(dir, "capture"),
        headless: headless ?? process.env.DEMOPILOT_HEADLESS !== "false",
        capture: ffmpeg ? "screencast" : "recordVideo",
        ffmpeg: ffmpeg ?? undefined,
      });

      const timelinePath = join(dir, "timeline.json");
      await writeFile(timelinePath, JSON.stringify(timeline, null, 2), "utf8");

      const mp4Path = join(dir, `${id}.mp4`);
      const result = await renderDemo({
        videoPath,
        timeline,
        outPath: mp4Path,
        fps,
        zoomOnClick,
        captions,
        audio: { music, musicVolume, sfx, voiceover },
        browserExecutable: resolveChromeForRemotion(),
      });

      const meta: RenderMeta = {
        name: id,
        mp4Path: result.outPath,
        timelinePath,
        width: result.width,
        height: result.height,
        fps: result.fps,
        durationMs: result.durationMs,
        createdAt: new Date().toISOString(),
      };
      await saveRenderMeta(meta);

      return text(
        `Rendered "${id}" → ${result.outPath}\n` +
          `${result.width}x${result.height} @ ${result.fps}fps, ~${(result.durationMs / 1000).toFixed(1)}s\n` +
          `Timeline sidecar: ${timelinePath}\n` +
          `Resource: demo://renders/${id}\n\n` +
          `Import the MP4 into Screen Studio (or any editor) for final polish.`,
      );
    },
  );

  server.registerTool(
    "render_demo_openscreen",
    {
      title: "Export demo to OpenScreen",
      description:
        "Export a demo as an EDITABLE OpenScreen project instead of a flat MP4. Replays the script and captures the CLEAN screen recording (raw capture — no zoom, no click ripples, no padding background baked into the pixels), then writes a self-contained OpenScreen project folder: that clean video + cursor telemetry + zoom/caption tracks. Zoom, ripples, and padding live in the project as editable layers, NOT in the footage — importing the finished/composited render instead would double-apply them. Ships polished-but-editable general settings (blurred background, padding, rounded corners, subtle shadow, a touch of motion blur) so it looks finished on first open. Open the .openscreen file in OpenScreen (File → Open Project) to hand-tune the zooms DemoPilot suggested — they arrive as real, editable keyframes. Renders the named saved demo, an inline script, or the active session.",
      inputSchema: {
        name: z.string().optional().describe("Name of a saved demo to export"),
        script: DemoScriptSchema.optional().describe("An inline demo script to export"),
        fps: z.number().int().positive().max(60).optional(),
        headless: z.boolean().optional(),
      },
    },
    async ({ name, script: inline, fps, headless }) => {
      const { script, id } = await resolveScript({ name, inline });
      const dir = join(renderDir(id), "openscreen");
      await mkdir(dir, { recursive: true });

      // Same capture path as render_demo: crisp constant-fps CDP screencast when
      // ffmpeg is available, else the realtime recordVideo backend.
      const ffmpeg = resolveBundledFfmpeg();
      const { videoPath, timeline } = await playDemo(script, {
        videoDir: join(dir, "capture"),
        headless: headless ?? process.env.DEMOPILOT_HEADLESS !== "false",
        capture: ffmpeg ? "screencast" : "recordVideo",
        ffmpeg: ffmpeg ?? undefined,
      });

      // Keep the timeline sidecar for debugging parity with render_demo.
      await writeFile(join(dir, "timeline.json"), JSON.stringify(timeline, null, 2), "utf8");

      const { writeOpenScreenProject } = await loadOpenScreenExporter();
      const project = await writeOpenScreenProject({ videoPath, timeline, outDir: dir, name: id, fps });

      return text(
        `Exported "${id}" as an editable OpenScreen project.\n` +
          `  project: ${project.projectPath}\n` +
          `  video:   ${project.videoPath}\n` +
          `  cursor:  ${project.cursorPath}\n` +
          `${project.zoomRegionCount} zoom region(s), ${project.annotationCount} caption(s), ` +
          `${project.cursorSampleCount} cursor sample(s).\n\n` +
          `Open in OpenScreen: File → Open Project → select the .openscreen file. ` +
          `The suggested zooms appear as editable keyframes you can hand-tune. ` +
          `(Keep the three files together — OpenScreen resolves the video relative to the project file.)`,
      );
    },
  );

  server.registerTool(
    "list_demos",
    { title: "List demos", description: "List saved demo scripts.", inputSchema: {} },
    async () => {
      const names = await listScripts();
      return text(names.length ? `Saved demos:\n${names.map((n) => `- ${n}`).join("\n")}` : "No saved demos yet.");
    },
  );

  server.registerTool(
    "get_demo",
    {
      title: "Get demo",
      description: "Return a saved demo script as YAML.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      const script = await loadScript(name);
      return text(JSON.stringify(script, null, 2));
    },
  );
}

function requireSession(): AuthoringSession {
  if (!state.session) throw new Error("No active session. Call open_app first.");
  return state.session;
}

async function resolveScript(args: { name?: string; inline?: DemoScript }): Promise<{ script: DemoScript; id: string }> {
  if (args.inline) return { script: args.inline, id: slug(args.inline.name) };
  if (args.name) return { script: await loadScript(args.name), id: slug(args.name) };
  if (state.session) {
    const script = state.session.toScript();
    return { script, id: slug(script.name) };
  }
  throw new Error("Nothing to render: provide a saved demo name, an inline script, or open a session first.");
}

interface WrittenOpenScreenProject {
  projectPath: string;
  videoPath: string;
  cursorPath: string;
  zoomRegionCount: number;
  annotationCount: number;
  cursorSampleCount: number;
}

interface OpenScreenExporter {
  writeOpenScreenProject(opts: {
    videoPath: string;
    timeline: Timeline;
    outDir: string;
    name?: string;
    fps?: number;
  }): Promise<WrittenOpenScreenProject>;
}

/**
 * Loads the OpenScreen exporter at runtime. It's a separate compositor subpath
 * (@demopilot/compositor/openscreen) because it pulls the Remotion browser-bundle
 * motion planner, whose Bundler-resolution (extensionless) imports can't be
 * type-checked under this package's NodeNext config. The specifier is widened to
 * `string` so the NodeNext typecheck doesn't statically resolve into that graph;
 * tsx resolves it at runtime. The small surface is declared above.
 */
async function loadOpenScreenExporter(): Promise<OpenScreenExporter> {
  const specifier: string = "@demopilot/compositor/openscreen";
  return (await import(specifier)) as OpenScreenExporter;
}
