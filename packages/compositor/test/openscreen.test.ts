import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenScreenProject, nearestDepth, OS_ZOOM_DEPTH_SCALES } from "../src/openscreen";
import type { Timeline } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const signupFlow = (): Timeline =>
  JSON.parse(readFileSync(join(here, "fixtures/signup-flow.timeline.json"), "utf8")) as Timeline;

describe("nearestDepth", () => {
  it("snaps a continuous level to the closest OpenScreen depth preset", () => {
    expect(nearestDepth(1.25)).toBe(1);
    expect(nearestDepth(1.5)).toBe(2);
    expect(nearestDepth(1.8)).toBe(3);
    expect(nearestDepth(2.2)).toBe(4);
    expect(nearestDepth(3.5)).toBe(5);
    expect(nearestDepth(5.0)).toBe(6);
    // Out-of-range levels clamp to the nearest end preset.
    expect(nearestDepth(1.0)).toBe(1);
    expect(nearestDepth(9.9)).toBe(6);
    // The chosen depth's scale really is the closest of the six.
    for (const level of [1.1, 1.6, 2.0, 2.9, 4.4]) {
      const d = nearestDepth(level);
      const err = Math.abs(OS_ZOOM_DEPTH_SCALES[d] - level);
      for (const other of [1, 2, 3, 4, 5, 6] as const) {
        expect(err).toBeLessThanOrEqual(Math.abs(OS_ZOOM_DEPTH_SCALES[other] - level) + 1e-9);
      }
    }
  });
});

describe("buildOpenScreenProject (signup-flow fixture)", () => {
  const tl = signupFlow();
  const videoPath = "/tmp/project/signup.mp4";
  const { project, cursor } = buildOpenScreenProject(tl, { screenVideoPath: videoPath });

  it("produces a version-2 project with editable-overlay media", () => {
    expect(project.version).toBe(2);
    expect(project.media.screenVideoPath).toBe(videoPath);
    expect(project.media.cursorCaptureMode).toBe("editable-overlay");
    // Auto-zoom is off so OpenScreen never recomputes over our suggested zooms.
    expect(project.editor.autoZoomEnabled).toBe(false);
    expect(project.editor.aspectRatio).toBe("native");
  });

  it("maps camera shots to editable, in-bounds manual zoom regions", () => {
    const zooms = project.editor.zoomRegions;
    expect(zooms.length).toBeGreaterThanOrEqual(1);
    const ids = new Set<string>();
    for (const z of zooms) {
      expect(z.id).toBeTruthy();
      expect(ids.has(z.id)).toBe(false); // ids are unique
      ids.add(z.id);
      expect(z.startMs).toBeGreaterThanOrEqual(0);
      expect(z.endMs).toBeGreaterThan(z.startMs);
      expect(z.endMs).toBeLessThanOrEqual(tl.durationMs);
      expect([1, 2, 3, 4, 5, 6]).toContain(z.depth);
      expect(z.focus.cx).toBeGreaterThanOrEqual(0);
      expect(z.focus.cx).toBeLessThanOrEqual(1);
      expect(z.focus.cy).toBeGreaterThanOrEqual(0);
      expect(z.focus.cy).toBeLessThanOrEqual(1);
      expect(z.focusMode).toBe("manual");
      expect(z.source).toBe("manual"); // behaves like a hand-placed zoom
      expect(z.customScale).toBeGreaterThanOrEqual(1);
      expect(z.customScale).toBeLessThanOrEqual(5);
      // The chosen depth preset is consistent with the exact scale.
      expect(z.depth).toBe(nearestDepth(z.customScale!));
    }
  });

  it("maps each narration to a lower-third text caption with a real window", () => {
    const captions = project.editor.annotationRegions;
    const narrations = tl.events.filter((e) => e.kind === "narrate");
    expect(captions).toHaveLength(narrations.length);
    const c = captions[0];
    expect(c.type).toBe("text");
    expect(c.content).toBe("Now let's create your first project");
    expect(c.textContent).toBe(c.content);
    expect(c.startMs).toBe(4900);
    expect(c.endMs).toBeGreaterThan(c.startMs);
    expect(c.endMs).toBeLessThanOrEqual(tl.durationMs);
    expect(c.position).toEqual({ x: 50, y: 85 }); // lower third
  });

  it("normalizes the cursor path and marks every click", () => {
    // Every original sample survives, normalized into 0..1 space.
    for (const s of cursor.samples) {
      expect(s.cx).toBeGreaterThanOrEqual(0);
      expect(s.cx).toBeLessThanOrEqual(1);
      expect(s.cy).toBeGreaterThanOrEqual(0);
      expect(s.cy).toBeLessThanOrEqual(1);
      expect(s.timeMs).toBeGreaterThanOrEqual(0);
    }
    // Samples are sorted by time.
    for (let i = 1; i < cursor.samples.length; i++) {
      expect(cursor.samples[i].timeMs).toBeGreaterThanOrEqual(cursor.samples[i - 1].timeMs);
    }
    // Each of the 3 fixture clicks is represented as a click sample.
    const clickCount = cursor.samples.filter((s) => s.interactionType === "click").length;
    expect(clickCount).toBe(tl.events.filter((e) => e.kind === "click").length);
    expect(cursor.version).toBe(2);
  });
});
