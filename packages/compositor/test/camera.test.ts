import { describe, it, expect } from "vitest";
import { buildActionGroups } from "../src/groups";
import { computeCameraTrack, cameraAt, cameraTransform, cameraSpeedAt, groupDepth } from "../src/camera";
import { cardLayout, CANVAS, FRAME } from "../src/frame";
import type { Timeline, Box } from "../src/types";

const FPS = 30;

function timeline(events: Timeline["events"], extra: Partial<Timeline> = {}): Timeline {
  return {
    version: 1,
    width: 1280,
    height: 800,
    durationMs: 9000,
    cursor: [
      { t: 0, x: 640, y: 400 },
      { t: 9000, x: 640, y: 400 },
    ],
    events,
    ...extra,
  };
}

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, width: w, height: h });

// A canonical login: two fields and a submit, all in the same form container.
function login(): Timeline {
  return timeline([
    { kind: "navigate", t: 0, url: "http://localhost/" },
    { kind: "type", tStart: 1000, t: 2500, text: "demo@acme.com", x: 640, y: 322, bbox: box(440, 300, 400, 44), container: "form#login" },
    { kind: "type", tStart: 3000, t: 4500, text: "hunter2demo", x: 640, y: 382, bbox: box(440, 360, 400, 44), container: "form#login" },
    { kind: "click", t: 5200, x: 520, y: 452, button: "left", bbox: box(440, 430, 160, 44), container: "form#login" },
  ]);
}

describe("buildActionGroups", () => {
  it("merges a same-container login into one group", () => {
    const groups = buildActionGroups(login(), 1800);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(3);
  });

  it("splits groups at a navigation", () => {
    const tl = timeline([
      { kind: "click", t: 1000, x: 200, y: 300, button: "left", bbox: box(160, 280, 80, 40), container: "nav" },
      { kind: "navigate", t: 2000, url: "http://localhost/next" },
      { kind: "click", t: 3000, x: 220, y: 300, button: "left", bbox: box(180, 280, 80, 40), container: "nav" },
    ]);
    expect(buildActionGroups(tl, 1800)).toHaveLength(2);
  });

  it("lets an explicit group marker override the heuristic split", () => {
    const tl = timeline([
      { kind: "group", t: 500, action: "start", name: "Setup" },
      { kind: "click", t: 1000, x: 150, y: 150, button: "left", bbox: box(120, 130, 60, 40), container: "a" },
      // Far apart in time and a different container — would split without the marker.
      { kind: "click", t: 6000, x: 1100, y: 600, button: "left", bbox: box(1070, 580, 60, 40), container: "b" },
      { kind: "group", t: 6500, action: "end" },
    ]);
    const groups = buildActionGroups(tl, 1800);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Setup");
  });
});

describe("adaptive depth", () => {
  it("zooms deeper for a small target than for a large region", () => {
    const small = timeline([
      { kind: "click", t: 1000, x: 200, y: 200, button: "left", bbox: box(170, 180, 60, 36), container: "a" },
    ]);
    const large = timeline([
      { kind: "click", t: 1000, x: 640, y: 400, button: "left", bbox: box(240, 200, 800, 420), container: "a" },
    ]);
    const dSmall = groupDepth(buildActionGroups(small, 1800)[0], small);
    const dLarge = groupDepth(buildActionGroups(large, 1800)[0], large);
    expect(dSmall).toBeGreaterThan(dLarge);
    // Small target saturates at the max; large region stays shallow.
    expect(dSmall).toBeCloseTo(1.8, 1);
    expect(dLarge).toBeLessThan(1.4);
  });
});

describe("camera (login)", () => {
  it("holds one steady anchored zoom across the whole login — no punch on submit", () => {
    const tl = login();
    const track = computeCameraTrack(tl, FPS);
    const typingScale = cameraAt(track, 2200).scale;
    const betweenFields = cameraAt(track, 2800).scale;
    const submitScale = cameraAt(track, 5200).scale;

    // Zoomed in throughout (never dips back to 1 between fields).
    for (const t of [1800, 2200, 2800, 3600, 4400, 5200]) {
      expect(cameraAt(track, t).scale).toBeGreaterThan(1.2);
    }
    // The submit click does not punch deeper than the typing hold (stays anchored).
    expect(submitScale).toBeLessThanOrEqual(typingScale + 0.04);
    expect(Math.abs(submitScale - betweenFields)).toBeLessThan(0.06);
    // Never exceeds the configured max depth.
    for (let t = 0; t <= tl.durationMs; t += 200) {
      expect(cameraAt(track, t).scale).toBeLessThan(1.9);
    }
  });

  it("anchors on the form, not on the submit button", () => {
    const track = computeCameraTrack(login(), FPS);
    // Focus stays near the form center (x≈640) rather than jumping to the button (x≈520).
    expect(cameraAt(track, 5200).focusX).toBeGreaterThan(600);
  });
});

describe("camera transitions", () => {
  it("stays zoomed and pans between two near groups", () => {
    const tl = timeline([
      { kind: "click", t: 1500, x: 560, y: 400, button: "left", bbox: box(530, 380, 60, 40), container: "a" },
      { kind: "click", t: 6000, x: 680, y: 420, button: "left", bbox: box(650, 400, 60, 40), container: "b" },
    ]);
    const track = computeCameraTrack(tl, FPS);
    // The gap between the groups keeps the camera zoomed (a pan, not a zoom-out).
    expect(cameraAt(track, 3750).scale).toBeGreaterThan(1.4);
  });

  it("eases out to an establishing shot between two far groups", () => {
    const tl = timeline([
      { kind: "click", t: 1500, x: 200, y: 400, button: "left", bbox: box(170, 380, 60, 40), container: "a" },
      { kind: "click", t: 6000, x: 1120, y: 400, button: "left", bbox: box(1090, 380, 60, 40), container: "b" },
    ]);
    const track = computeCameraTrack(tl, FPS);
    const hold = cameraAt(track, 1600).scale;
    // Sample across the gap and confirm the depth dips well below the group hold.
    let minScale = Infinity;
    for (let t = 2200; t <= 5300; t += 100) minScale = Math.min(minScale, cameraAt(track, t).scale);
    expect(minScale).toBeLessThan(hold - 0.2);
    expect(minScale).toBeLessThan(1.4);
  });
});

describe("cameraTransform (fit-to-rect, edge-clamped)", () => {
  const VW = 1280;
  const VH = 800;

  // Content spans [tx, tx + vw*scale]; it fully covers [0, vw] iff the left edge
  // is at/past 0 and the right edge is at/before vw — i.e. no background bleed.
  const covers = (t: number, span: number, scale: number) => t <= 1e-6 && t + span * scale >= span - 1e-6;

  it("never lets content escape the card, even for corner focus at max zoom", () => {
    const maxZoom = 1.8;
    // Sweep every corner and the bare edges/center — the worst cases for bleed.
    const fracs = [0, 0.5, 1];
    for (const fx of fracs) {
      for (const fy of fracs) {
        const { tx, ty, scale } = cameraTransform(
          { scale: maxZoom, focusX: VW * fx, focusY: VH * fy },
          VW,
          VH,
        );
        expect(covers(tx, VW, scale)).toBe(true);
        expect(covers(ty, VH, scale)).toBe(true);
        // The clamp pins translation within its valid coverage range.
        expect(tx).toBeGreaterThanOrEqual(-VW * (scale - 1) - 1e-6);
        expect(tx).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it("holds the coverage invariant across arbitrary focus points and zoom levels", () => {
    for (let scale = 1; scale <= 1.8; scale += 0.2) {
      for (let fx = -200; fx <= VW + 200; fx += 160) {
        for (let fy = -200; fy <= VH + 200; fy += 160) {
          const { tx, ty } = cameraTransform({ scale, focusX: fx, focusY: fy }, VW, VH);
          expect(covers(tx, VW, scale)).toBe(true);
          expect(covers(ty, VH, scale)).toBe(true);
        }
      }
    }
  });

  it("centers a centered target exactly", () => {
    const scale = 1.5;
    const { tx, ty } = cameraTransform({ scale, focusX: VW / 2, focusY: VH / 2 }, VW, VH);
    // The focus point maps to the viewport center under translate+scale.
    expect(tx + (VW / 2) * scale).toBeCloseTo(VW / 2, 6);
    expect(ty + (VH / 2) * scale).toBeCloseTo(VH / 2, 6);
  });

  it("is the identity at scale 1 (no pan when not zoomed)", () => {
    const { tx, ty, scale } = cameraTransform({ scale: 1, focusX: 100, focusY: 700 }, VW, VH);
    expect(tx).toBeCloseTo(0, 6);
    expect(ty).toBeCloseTo(0, 6);
    expect(scale).toBe(1);
  });
});

describe("cameraSpeedAt (synthetic motion-blur driver)", () => {
  it("is ~0 on a settled hold and large during a transition", () => {
    // Settled hold: one steady group, sampled deep into the hold.
    const loginTrack = computeCameraTrack(login(), 60);
    const hold = cameraSpeedAt(loginTrack, 4800, 1280, 800);
    expect(hold).toBeLessThan(2);

    // Far transition: the camera eases out + pans across the frame.
    const far = timeline([
      { kind: "click", t: 1500, x: 200, y: 400, button: "left", bbox: box(170, 380, 60, 40), container: "a" },
      { kind: "click", t: 6000, x: 1120, y: 400, button: "left", bbox: box(1090, 380, 60, 40), container: "b" },
    ]);
    const farTrack = computeCameraTrack(far, 60);
    let maxSpeed = 0;
    for (let t = 2200; t <= 5300; t += 50) maxSpeed = Math.max(maxSpeed, cameraSpeedAt(farTrack, t, 1280, 800));
    expect(maxSpeed).toBeGreaterThan(15);
  });
});

describe("card layout (constant outer padding)", () => {
  it("places the card the same regardless of zoom (camera lives inside the card)", () => {
    // The card layout is a pure function of canvas/video dims + pad — it has no
    // zoom input, so the outer padding is constant for the entire render.
    const a = cardLayout(CANVAS.width, CANVAS.height, 1280, 800);
    const b = cardLayout(CANVAS.width, CANVAS.height, 1280, 800);
    expect(a).toEqual(b);
    // Centered with equal margins; the card never bleeds past the canvas.
    expect(a.left).toBeCloseTo((CANVAS.width - 1280 * a.scale) / 2, 6);
    expect(a.top).toBeCloseTo((CANVAS.height - 800 * a.scale) / 2, 6);
    expect(a.left).toBeGreaterThanOrEqual(FRAME.pad - 1e-6);
    expect(a.top).toBeGreaterThanOrEqual(FRAME.pad - 1e-6);
  });
});
