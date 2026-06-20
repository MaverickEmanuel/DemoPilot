import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DemoScriptSchema, type DemoScript } from "./schema.js";

/** Loads and validates a demo script from a YAML or JSON file. */
export async function loadDemoScript(path: string): Promise<DemoScript> {
  const raw = await readFile(path, "utf8");
  const data = path.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  return DemoScriptSchema.parse(data);
}

/** Serializes a validated demo script to YAML on disk. */
export async function saveDemoScript(path: string, script: DemoScript): Promise<void> {
  const validated = DemoScriptSchema.parse(script);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(validated), "utf8");
}
