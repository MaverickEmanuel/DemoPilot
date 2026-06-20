import { describe, it, expect } from "vitest";
import { parseDemoScript, demoScriptJsonSchema, TimelineRecorder } from "../src/index.js";

describe("DemoScript schema", () => {
  it("parses a minimal valid script and applies defaults", () => {
    const script = parseDemoScript({
      name: "Demo",
      baseUrl: "http://localhost:4321",
      steps: [{ goto: "/" }],
    });
    expect(script.viewport).toEqual({ width: 1280, height: 800 });
    expect(script.defaults.typeCadence).toBe("human");
    expect(script.defaults.mousePace).toBe("natural");
    // Pacing knobs apply their calibrated, unhurried defaults.
    expect(script.defaults.readPause).toBe(900);
    expect(script.defaults.preActionDwell).toBe(450);
    expect(script.defaults.postActionHold).toBe(650);
    expect(script.defaults.speed).toBe(1);
  });

  it("accepts custom pacing knobs and a speed multiplier", () => {
    const script = parseDemoScript({
      name: "Demo",
      baseUrl: "http://localhost:4321",
      defaults: { preActionDwell: 200, postActionHold: 300, readPause: 500, speed: 1.5 },
      steps: [{ goto: "/" }],
    });
    expect(script.defaults.speed).toBe(1.5);
    expect(script.defaults.preActionDwell).toBe(200);
  });

  it("rejects a non-positive speed", () => {
    expect(() =>
      parseDemoScript({
        name: "x",
        baseUrl: "http://localhost",
        defaults: { speed: 0 },
        steps: [{ goto: "/" }],
      }),
    ).toThrow();
  });

  it("rejects a step with no action key", () => {
    expect(() =>
      parseDemoScript({ name: "x", baseUrl: "http://localhost", steps: [{}] }),
    ).toThrow();
  });

  it("rejects a target with no selector", () => {
    expect(() =>
      parseDemoScript({
        name: "x",
        baseUrl: "http://localhost",
        steps: [{ click: { target: {} } }],
      }),
    ).toThrow();
  });

  it("exports a JSON Schema", () => {
    const schema = demoScriptJsonSchema();
    expect(schema).toHaveProperty("$ref");
  });
});

describe("TimelineRecorder", () => {
  it("records cursor samples and discrete events in order", () => {
    let now = 1000;
    const rec = new TimelineRecorder(1280, 800, () => now);
    rec.sampleCursor(10, 10);
    now = 1100;
    rec.navigate("http://localhost/");
    now = 1200;
    rec.click(50, 60, "left");
    now = 1300;
    rec.type("hello");
    const tl = rec.finish();

    expect(tl.width).toBe(1280);
    expect(tl.cursor[0]).toMatchObject({ t: 0, x: 10, y: 10 });
    expect(tl.events.map((e) => e.kind)).toEqual(["navigate", "click", "type"]);
    expect(tl.durationMs).toBe(300);
  });
});
