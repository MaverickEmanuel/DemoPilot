import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const WORKFLOW = `You are authoring a product demo video with DemoPilot. Follow this loop:

1. open_app({ url, name }) — launch the target app and read the accessibility tree.
2. snapshot() — re-read the page whenever it changes to choose the next target.
3. act({ step }) — perform ONE step at a time. Prefer accessibility targets:
     { role: "button", name: "Create account" } over CSS.
     Step kinds: goto, click, type, press, hover, scroll, waitFor, select, pause, narrate.
   If a step fails, adjust the target using the latest snapshot and retry.
4. add_narration({ text }) — add a caption before key moments to guide the viewer.
5. Insert waitFor after navigations/async UI so the demo stays reliable on replay.
6. save_demo({ name }) — once the flow is complete and validated.
7. render_demo({ name }) — produce the MP4 (clean capture + composited cursor/zoom).

Keep the flow tight and purposeful, like a real product walkthrough. The script you
build is reproducible: render it again any time without re-driving the app.`;

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "author_demo",
    {
      title: "Author a demo",
      description: "Guided workflow for turning a described demo into a reproducible script and MP4.",
      argsSchema: {
        goal: z.string().describe("What the demo should show"),
        url: z.string().describe("URL of the app to demo"),
      },
    },
    ({ goal, url }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `${WORKFLOW}\n\n---\nDemo goal: ${goal}\nApp URL: ${url}\n\nBegin by calling open_app.`,
          },
        },
      ],
    }),
  );
}
