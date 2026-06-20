/**
 * End-to-end verification: serve the seed app, replay the example demo script,
 * and render an MP4 — no MCP client or external app required.
 *
 *   pnpm render:example
 */
import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { loadDemoScript, playDemo } from "@demopilot/core";
import { renderDemo } from "@demopilot/compositor";
import { resolveChromeForRemotion } from "./chrome.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const seedRoot = join(repoRoot, "examples/seed-app");
const scriptPath = join(repoRoot, "examples/scripts/first-demo.yaml");
const outPath = join(repoRoot, "renders/first-demo.mp4");

const mime: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

function serveSeedApp(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let p = (req.url ?? "/").split("?")[0];
        if (p === "/") p = "/index.html";
        const file = normalize(join(seedRoot, p));
        if (!file.startsWith(seedRoot)) return res.writeHead(403).end();
        const body = await readFile(file);
        res.writeHead(200, { "Content-Type": mime[file.slice(file.lastIndexOf("."))] ?? "text/plain" }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 4321 });
    });
  });
}

async function main(): Promise<void> {
  const { server, port } = await serveSeedApp();
  console.log(`[render:example] seed app on http://localhost:${port}`);
  try {
    const script = await loadDemoScript(scriptPath);
    script.baseUrl = `http://localhost:${port}`;

    console.log("[render:example] replaying + capturing…");
    const { videoPath, timeline } = await playDemo(script, {
      videoDir: join(repoRoot, "renders/.capture"),
      headless: true,
    });

    // Persist the intermediate artifacts so capture problems can be separated
    // from compositing problems (analyze timeline.json; inspect the clean webm).
    const timelinePath = join(repoRoot, "renders/timeline.json");
    await writeFile(timelinePath, JSON.stringify(timeline, null, 2));
    console.log(`[render:example] timeline → ${timelinePath} (clean webm → ${videoPath})`);

    console.log("[render:example] compositing MP4…");
    const result = await renderDemo({
      videoPath,
      timeline,
      outPath,
      // Reuse the installed Playwright chrome-headless-shell so Remotion needn't download one.
      browserExecutable: resolveChromeForRemotion(),
      onProgress: (r) => process.stdout.write(`\r  ${(r * 100).toFixed(0)}%   `),
    });
    process.stdout.write("\n");
    console.log(`[render:example] done → ${result.outPath} (${result.width}x${result.height} @ ${result.fps}fps)`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
