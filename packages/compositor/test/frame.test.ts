import { describe, it, expect } from "vitest";
import {
  BACKGROUNDS,
  MESHES,
  DEFAULT_BACKGROUND,
  FRAME,
  backgroundFor,
  meshBackgroundAt,
} from "../src/frame";

describe("backgrounds", () => {
  it("defaults to a mesh preset", () => {
    expect(DEFAULT_BACKGROUND).toBe("aurora-mesh");
    expect(MESHES[DEFAULT_BACKGROUND]).toBeDefined();
    // The default frame background is the flattened mesh CSS.
    expect(FRAME.background).toBe(BACKGROUNDS[DEFAULT_BACKGROUND]);
    expect(backgroundFor()).toBe(FRAME.background);
  });

  it("ships 6 mesh presets covering cool/warm/neutral-light/vivid", () => {
    for (const k of ["aurora-mesh", "nebula", "ember", "dawn", "mist", "spectrum"]) {
      expect(MESHES[k]).toBeDefined();
      const css = backgroundFor(k);
      // Stacked radial blobs over a base gradient.
      expect(css.match(/radial-gradient/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
      expect(css).toContain("linear-gradient");
    }
  });

  it("keeps the legacy single-gradient presets for back-compat", () => {
    for (const k of ["midnight", "dusk", "daylight", "aurora"]) {
      expect(BACKGROUNDS[k]).toBeDefined();
    }
    // Legacy 'aurora' is a single gradient, distinct from the new 'aurora-mesh'.
    expect(BACKGROUNDS.aurora).not.toBe(BACKGROUNDS["aurora-mesh"]);
  });

  it("passes through a raw CSS background string unchanged", () => {
    const raw = "linear-gradient(90deg, #000, #fff)";
    expect(backgroundFor(raw)).toBe(raw);
  });

  it("is static over time when drift is off", () => {
    const a = meshBackgroundAt("nebula", 0, false);
    const b = meshBackgroundAt("nebula", 12.5, false);
    expect(a).toBe(b);
    expect(a).toBe(BACKGROUNDS.nebula);
  });

  it("drifts over time but stays valid and periodic", () => {
    const period = 24;
    const t0 = meshBackgroundAt("aurora-mesh", 0, true, period);
    const tMid = meshBackgroundAt("aurora-mesh", period / 2, true, period);
    const tLoop = meshBackgroundAt("aurora-mesh", period, true, period);
    // Different mid-cycle, identical after a full period (seamless loop).
    expect(tMid).not.toBe(t0);
    expect(tLoop).toBe(t0);
    expect(tMid).toContain("radial-gradient");
  });

  it("falls back to static resolution for non-mesh names", () => {
    expect(meshBackgroundAt("midnight", 5, true)).toBe(BACKGROUNDS.midnight);
    expect(meshBackgroundAt(undefined, 5, false)).toBe(FRAME.background);
  });
});
