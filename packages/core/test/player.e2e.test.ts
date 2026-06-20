import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile, stat, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { parseDemoScript, playDemo } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedRoot = join(__dirname, "../../../examples/seed-app");

// The e2e test needs Chromium installed (npx playwright install chromium).
// It is skipped automatically when the browser isn't available.
async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    return Boolean(exe) && existsSync(exe);
  } catch {
    return false;
  }
}

const types: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
};

function startSeedServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        let path = (req.url ?? "/").split("?")[0];
        if (path === "/") path = "/index.html";
        const filePath = normalize(join(seedRoot, path));
        if (!filePath.startsWith(seedRoot)) return res.writeHead(403).end();
        const body = await readFile(filePath);
        res.writeHead(200, { "Content-Type": types[filePath.slice(filePath.lastIndexOf("."))] ?? "text/plain" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("playDemo (e2e)", () => {
  let server: Server;
  let port = 0;
  let hasBrowser = false;

  beforeAll(async () => {
    hasBrowser = await chromiumAvailable();
    if (!hasBrowser) return;
    ({ server, port } = await startSeedServer());
  });

  afterAll(() => {
    server?.close();
  });

  it("records a clean video + synchronized timeline", async (ctx) => {
    if (!hasBrowser) {
      ctx.skip();
      return;
    }
    const script = parseDemoScript({
      name: "Signup smoke",
      baseUrl: `http://localhost:${port}`,
      viewport: { width: 1024, height: 700 },
      defaults: { mousePace: "fast", typeCadence: "fast" },
      steps: [
        { goto: "/" },
        { narrate: "Create an account" },
        { type: { target: { role: "textbox", name: "Email" }, text: "demo@acme.com" } },
        { type: { target: { role: "textbox", name: "Password" }, text: "hunter2" } },
        { click: { target: { role: "button", name: "Create account" } } },
        { waitFor: { target: { text: "Welcome to Acme" } } },
      ],
    });

    const outDir = await mkdtemp(join(tmpdir(), "demopilot-"));
    const { videoPath, timeline } = await playDemo(script, { videoDir: outDir, headless: true });

    expect((await stat(videoPath)).size).toBeGreaterThan(0);
    expect(timeline.events.some((e) => e.kind === "navigate")).toBe(true);
    expect(timeline.events.some((e) => e.kind === "click")).toBe(true);
    expect(timeline.cursor.length).toBeGreaterThan(2);
    expect(timeline.durationMs).toBeGreaterThan(0);
  }, 60_000);
});
