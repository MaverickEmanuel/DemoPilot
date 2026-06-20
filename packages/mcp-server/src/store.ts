import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadDemoScript, saveDemoScript, type DemoScript } from "@demopilot/core";

/**
 * On-disk home for authored scripts and rendered artifacts. Override with
 * DEMOPILOT_DATA_DIR; defaults to ./.demopilot under the current directory.
 */
export function dataDir(): string {
  return resolve(process.env.DEMOPILOT_DATA_DIR ?? join(process.cwd(), ".demopilot"));
}

const scriptsDir = () => join(dataDir(), "scripts");
const rendersDir = () => join(dataDir(), "renders");

export const scriptPath = (name: string) => join(scriptsDir(), `${name}.yaml`);
export const renderDir = (name: string) => join(rendersDir(), name);

export interface RenderMeta {
  name: string;
  mp4Path: string;
  timelinePath: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  createdAt: string;
}

export async function listScripts(): Promise<string[]> {
  try {
    const files = await readdir(scriptsDir());
    return files.filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort();
  } catch {
    return [];
  }
}

export async function saveScript(name: string, script: DemoScript): Promise<string> {
  const path = scriptPath(name);
  await saveDemoScript(path, script);
  return path;
}

export async function loadScript(name: string): Promise<DemoScript> {
  return loadDemoScript(scriptPath(name));
}

export async function saveRenderMeta(meta: RenderMeta): Promise<void> {
  const dir = renderDir(meta.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "render.json"), JSON.stringify(meta, null, 2), "utf8");
}

export async function loadRenderMeta(name: string): Promise<RenderMeta> {
  const raw = await readFile(join(renderDir(name), "render.json"), "utf8");
  return JSON.parse(raw) as RenderMeta;
}

export async function listRenders(): Promise<string[]> {
  try {
    return (await readdir(rendersDir(), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
