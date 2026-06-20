import { describe, it, expect } from "vitest";
import { zoomAt } from "../src/interp";
import type { Timeline } from "../src/types";

/** A timeline with a steady cursor at (cx, cy) plus the given events. */
function timeline(events: Timeline["events"], cx = 400, cy = 300): Timeline {
  return {
    version: 1,
    width: 1280,
    height: 800,
    durationMs: 8000,
    cursor: [
      { t: 0, x: cx, y: cy },
      { t: 8000, x: cx, y: cy },
    ],
    events,
  };
}

describe("zoomAt", () => {
  it("holds one sustained zoom across a multi-field sequence", () => {
    // email typed 1000→3000, password 3500→6000, submit click at 6500.
    const tl = timeline([
      { kind: "type", tStart: 1000, t: 3000, text: "demo@acme.com" },
      { kind: "type", tStart: 3500, t: 6000, text: "hunter2demo" },
      { kind: "click", t: 6500, x: 500, y: 360, button: "left" },
    ]);

    // Zoomed in through the entire span (no dip back to 1 between fields).
    for (const t of [1200, 2500, 3500, 4800, 6000, 6700]) {
      expect(zoomAt(tl, t).scale).toBeGreaterThan(1.0);
    }
    // Peaks at the configured default magnification in the middle of the hold.
    expect(zoomAt(tl, 4000).scale).toBeCloseTo(1.25, 2);
    // Eases back out after the tail.
    expect(zoomAt(tl, 7800).scale).toBeCloseTo(1.0, 2);
  });

  it("keeps typing anchored on the form, then recenters and punches on a click", () => {
    const tl = timeline([
      { kind: "type", tStart: 1000, t: 3000, text: "demo@acme.com" },
      { kind: "click", t: 4000, x: 600, y: 500, button: "left" },
    ]);
    // During typing the focus sits on the field and holds the base level.
    const typing = zoomAt(tl, 2000);
    expect(typing.originX).toBeCloseTo(400, 0);
    expect(typing.originY).toBeCloseTo(300, 0);
    expect(typing.scale).toBeCloseTo(1.25, 2);
    // At the click the focus moves onto the button and punches in deeper.
    const click = zoomAt(tl, 4000);
    expect(click.originX).toBeGreaterThan(typing.originX + 50);
    expect(click.scale).toBeGreaterThan(1.3);
  });

  it("honors the timeline zoom level and clickBoost overrides", () => {
    const tl = {
      ...timeline([
        { kind: "type", tStart: 1000, t: 3000, text: "x" },
        { kind: "click", t: 5000, x: 400, y: 300, button: "left" },
      ]),
      zoom: { level: 1.5, clickBoost: 0.2 },
    };
    // Typing holds the base level; the click punches to base + clickBoost
    // (sampled at the punch's peak, which sits just before the press).
    expect(zoomAt(tl, 2000).scale).toBeCloseTo(1.5, 2);
    expect(zoomAt(tl, 4940).scale).toBeCloseTo(1.7, 2);
  });

  it("produces a zoom from an explicit in/out region", () => {
    const tl = timeline([
      { kind: "zoom", t: 1000, action: "in" },
      { kind: "click", t: 2000, x: 400, y: 300, button: "left" },
      { kind: "zoom", t: 3000, action: "out" },
    ]);
    expect(zoomAt(tl, 2000).scale).toBeGreaterThan(1.0);
    // Fully released outside the region.
    expect(zoomAt(tl, 200).scale).toBeCloseTo(1.0, 2);
  });
});
