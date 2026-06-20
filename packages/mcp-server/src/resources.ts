import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stringify as stringifyYaml } from "yaml";
import { demoScriptJsonSchema } from "@demopilot/core";
import { listScripts, loadScript, listRenders, loadRenderMeta } from "./store.js";

const one = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);

export function registerResources(server: McpServer): void {
  server.registerResource(
    "schema",
    "demo://schema",
    {
      title: "Demo script JSON Schema",
      description: "JSON Schema describing the DemoPilot demo script format.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "application/json", text: JSON.stringify(demoScriptJsonSchema(), null, 2) },
      ],
    }),
  );

  server.registerResource(
    "scripts",
    new ResourceTemplate("demo://scripts/{name}", {
      list: async () => ({
        resources: (await listScripts()).map((name) => ({
          name,
          uri: `demo://scripts/${name}`,
          mimeType: "text/yaml",
        })),
      }),
    }),
    { title: "Saved demo scripts", description: "Authored demo scripts (YAML)." },
    async (uri, variables) => {
      const script = await loadScript(one(variables.name));
      return { contents: [{ uri: uri.href, mimeType: "text/yaml", text: stringifyYaml(script) }] };
    },
  );

  server.registerResource(
    "renders",
    new ResourceTemplate("demo://renders/{name}", {
      list: async () => ({
        resources: (await listRenders()).map((name) => ({
          name,
          uri: `demo://renders/${name}`,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Rendered demos", description: "Metadata for rendered demos (MP4 path, dimensions, duration)." },
    async (uri, variables) => {
      const meta = await loadRenderMeta(one(variables.name));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(meta, null, 2) }] };
    },
  );
}
