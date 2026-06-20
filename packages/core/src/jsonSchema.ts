import { zodToJsonSchema } from "zod-to-json-schema";
import { DemoScriptSchema } from "./schema.js";

/** JSON Schema for a DemoPilot demo script, exposed via the MCP `demo://schema` resource. */
export function demoScriptJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(DemoScriptSchema, "DemoScript") as Record<string, unknown>;
}
