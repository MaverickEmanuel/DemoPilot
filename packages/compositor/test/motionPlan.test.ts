import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildMotionPlan,
  computeCameraMotion,
  outputDurationMs,
  OUTRO_HOLD_MS,
  IDLE_FADE_AFTER_MS,
  FOLLOW_LAG_MS,
  type MotionPlan,
} from "../src/motionPlan";
import { plannedCursorAt, minJerk } from "../src/interp";
import { cameraAt, cameraTransform, cameraSpeedAt, type CameraTrack } from "../src/camera";
import { cardLayout, CANVAS } from "../src/frame";
import type { Timeline } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));
const signupFlow = (): Timeline =>
  JSON.parse(readFileSync(join(here, "fixtures/signup-flow.timeline.json"), "utf8")) as Timeline;

const FPS = 30;
const frameMs = 1000 / FPS;

/** A video point projected to canvas (apparent) px through the sampled camera. */
function projectCanvas(track: CameraTrack, p: { x: number; y: number }, tMs: number, tl: Timeline, layoutScale: number) {
  const v = cameraTransform(cameraAt(track, tMs), tl.width, tl.height);
  return { x: (v.tx + p.x * v.scale) * layoutScale, y: (v.ty + p.y * v.scale) * layoutScale };
}

describe("minJerk", () => {
  it("is a 0→1 ramp with zero end-velocity (smootherstep)", () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5, 6);
    // Monotonic and clamped outside [0,1].
    expect(minJerk(-1)).toBe(0);
    expect(minJerk(2)).toBe(1);
    let prev = -1;
    for (let u = 0; u <= 1; u += 0.05) {
      const v = minJerk(u);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("buildMotionPlan (signup-flow fixture)", () => {
  const tl = signupFlow();
  const plan = buildMotionPlan(tl, FPS);
  const { track } = computeCameraMotion(tl, FPS);
  const layoutScale = cardLayout(CANVAS.width, CANVAS.height, tl.width, tl.height).scale;

  it("derives three shots, cross-page travels, and one nav establish-hold", () => {
    expect(plan.shots).toHaveLength(3); // Sign in group, New Project, dialog
    expect(plan.navs).toHaveLength(1); // the SPA nav between shot 0 and shot 1
    expect(plan.travels.length).toBeGreaterThanOrEqual(4);
    // Travels are sorted by tDepart and never overlap.
    for (let i = 1; i < plan.travels.length; i++) {
      expect(plan.travels[i].tDepart).toBeGreaterThanOrEqual(plan.travels[i - 1].tArrive);
    }
    // The two group-crossing travels are tagged with the shot they enter.
    const crossing = plan.travels.filter((t) => t.toShot !== null);
    expect(crossing.length).toBe(2);
  });

  // 1. Apparent speed cap. min-jerk's instantaneous velocity peaks at ~1.9× its
  // average, so the 850 px/s *average* target reaches a higher instantaneous
  // peak — partly offset by the follow-cam (which pans WITH the cursor). The
  // observed ceiling (~1300) is far below the pre-fix whip (several thousand
  // px/s); this guards against regressing to that.
  it("caps the apparent cursor speed inside every travel", () => {
    let maxSpeed = 0;
    for (const tr of plan.travels) {
      for (let t = tr.tDepart; t <= tr.tArrive; t += frameMs) {
        const p0 = projectCanvas(track, plannedCursorAt(plan, tl.cursor, t), t, tl, layoutScale);
        const p1 = projectCanvas(track, plannedCursorAt(plan, tl.cursor, t + frameMs), t + frameMs, tl, layoutScale);
        maxSpeed = Math.max(maxSpeed, Math.hypot(p1.x - p0.x, p1.y - p0.y) / (frameMs / 1000));
      }
    }
    expect(maxSpeed).toBeLessThanOrEqual(1400);
  });

  // 2. No opposite motion. The follow-cam must pan the SAME way the cursor
  // travels. Measured in video space (cursor velocity vs camera focus velocity);
  // a screen-space comparison is confounded by parallax — the background moves
  // against the pan, so a fixed point's screen velocity opposes a following
  // cursor even when the camera is correctly following.
  it("never pans the camera against the cursor's travel", () => {
    let worstDot = Infinity;
    for (let t = 0; t <= plan.durationMs; t += frameMs) {
      const c0 = plannedCursorAt(plan, tl.cursor, t);
      const c1 = plannedCursorAt(plan, tl.cursor, t + frameMs);
      const cam0 = cameraAt(track, t);
      const cam1 = cameraAt(track, t + frameMs);
      const cur = { x: c1.x - c0.x, y: c1.y - c0.y };
      const cam = { x: cam1.focusX - cam0.focusX, y: cam1.focusY - cam0.focusY };
      const perSec = 1000 / frameMs;
      if (Math.hypot(cur.x, cur.y) * perSec > 40 && Math.hypot(cam.x, cam.y) * perSec > 40) {
        worstDot = Math.min(worstDot, cur.x * cam.x + cur.y * cam.y);
      }
    }
    expect(worstDot).toBeGreaterThanOrEqual(-1e-6);
  });

  // 3. Nav stillness: the cursor parks and the camera holds the establish framing.
  it("holds still through the navigation establish beat", () => {
    for (const nv of plan.navs) {
      // The travel that ends the establish-hold departs at t1 − FOLLOW_LAG_MS.
      const enter = plan.travels.find((t) => Math.abs(t.tDepart + FOLLOW_LAG_MS - nv.t1) < 1);
      expect(enter).toBeTruthy();
      const departAt = enter!.tDepart;
      // The planned cursor does not move while parked (t0 → the travel departs).
      const anchor = plannedCursorAt(plan, tl.cursor, nv.t0);
      for (let t = nv.t0; t <= departAt; t += frameMs) {
        const c = plannedCursorAt(plan, tl.cursor, t);
        expect(Math.hypot(c.x - anchor.x, c.y - anchor.y)).toBeLessThan(1e-6);
      }
      // The establish framing has settled by t0 + 900 ms (≈0.5 px/frame; a pan is
      // 5–15 px/frame), and is essentially motionless (<0.15 px/frame) by t0+1000.
      expect(nv.t1 - nv.t0).toBeGreaterThan(900);
      for (let t = nv.t0 + 900; t <= nv.t1; t += frameMs) {
        expect(cameraSpeedAt(track, t, tl.width, tl.height)).toBeLessThan(0.6);
      }
    }
  });

  // 4. Click accuracy: recorded click points stay pixel-exact.
  it("keeps click points pixel-exact", () => {
    for (const e of tl.events) {
      if (e.kind !== "click") continue;
      const c = plannedCursorAt(plan, tl.cursor, e.t);
      expect(c.x).toBe(e.x);
      expect(c.y).toBe(e.y);
    }
  });

  // 5. Idle fade: short parks stay visible; long parks fade.
  it("emits idle fades only for holds longer than the idle threshold", () => {
    const shortHolds = plan.holds.filter((h) => h.t1 - h.t0 <= IDLE_FADE_AFTER_MS);
    expect(shortHolds.length).toBeGreaterThan(0);
    // No idle fade lines up with a short hold's fade-out time.
    for (const h of shortHolds) {
      expect(plan.idleFades.some((f) => Math.abs(f.fadeOutAt - (h.t0 + IDLE_FADE_AFTER_MS)) < 1)).toBe(false);
    }
    // A long non-final park fades out then back in *before* the next travel departs.
    const nonFinal = plan.idleFades.filter((f) => Number.isFinite(f.fadeInAt));
    expect(nonFinal.length).toBeGreaterThan(0);
    for (const f of nonFinal) {
      expect(f.fadeInAt).toBeGreaterThan(f.fadeOutAt);
      const nextTravel = plan.travels.find((t) => t.tDepart >= f.fadeInAt);
      expect(nextTravel).toBeTruthy();
      expect(f.fadeInAt).toBeLessThanOrEqual(nextTravel!.tDepart);
    }
    // The final park fades out and never returns (no next travel).
    expect(plan.idleFades.some((f) => f.fadeInAt === Infinity)).toBe(true);
  });

  // 6. Determinism: the plan is a pure function of (timeline, fps).
  it("is deterministic (equal plans from equal input)", () => {
    expect(buildMotionPlan(tl, FPS)).toEqual(buildMotionPlan(tl, FPS));
  });

  // 7. Ending: the composition extends past the recording and rests on a landing.
  it("extends the composition and rests the camera on the outro landing", () => {
    expect(plan.outputDurationMs).toBe(plan.durationMs + OUTRO_HOLD_MS);
    expect(outputDurationMs(tl.durationMs)).toBe(plan.outputDurationMs);
    expect(plan.outputDurationMs).toBeGreaterThan(plan.durationMs);
    // At the final frame the camera has settled on the gentle outro landing
    // (a slight pull-back, centered) rather than a full zoom-out.
    const finalCam = cameraAt(track, plan.outputDurationMs);
    expect(finalCam.scale).toBeGreaterThan(1.1);
    expect(finalCam.scale).toBeLessThan(1.14);
    expect(finalCam.focusX).toBeCloseTo(tl.width / 2, 2);
    expect(finalCam.focusY).toBeCloseTo(tl.height / 2, 2);
  });
});

// A degenerate timeline (no geometry) still yields a usable, finite plan.
describe("buildMotionPlan (older/degenerate timeline)", () => {
  it("falls back gracefully with no recorded landing samples", () => {
    const tl: Timeline = {
      version: 1,
      width: 1280,
      height: 800,
      durationMs: 6000,
      cursor: [
        { t: 0, x: 640, y: 400 },
        { t: 6000, x: 640, y: 400 },
      ],
      events: [
        { kind: "click", t: 1500, x: 300, y: 300, button: "left" },
        { kind: "click", t: 4000, x: 900, y: 500, button: "left" },
      ],
    };
    const plan: MotionPlan = buildMotionPlan(tl, FPS);
    expect(plan.shots.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(plan.outputDurationMs)).toBe(true);
    // Click points are still exact even without landing samples.
    expect(plannedCursorAt(plan, tl.cursor, 1500)).toEqual({ x: 300, y: 300 });
    expect(plannedCursorAt(plan, tl.cursor, 4000)).toEqual({ x: 900, y: 500 });
    // The arrival hold pins the cursor on target through the pre-action dwell —
    // even here, where the recorded samples never landed on it (no teleport).
    const toSecond = plan.travels.find((t) => t.to.x === 900 && t.to.y === 500);
    expect(toSecond).toBeTruthy();
    for (let t = toSecond!.tArrive + 1; t < 4000; t += 20) {
      const c = plannedCursorAt(plan, tl.cursor, t);
      expect(Math.hypot(c.x - 900, c.y - 500)).toBeLessThan(1e-6);
    }
  });

  it("abuts same-page shot windows when no boundary travel is synthesized", () => {
    // Two group-crossing clicks within MIN_TRAVEL_DIST_PX (no travel), split into
    // two shots (>groupGapMs apart, no shared container), with no navigation.
    const tl: Timeline = {
      version: 1,
      width: 1280,
      height: 800,
      durationMs: 6000,
      cursor: [
        { t: 0, x: 400, y: 300 },
        { t: 6000, x: 401, y: 300 },
      ],
      events: [
        { kind: "click", t: 1500, x: 400, y: 300, button: "left", bbox: { x: 380, y: 280, width: 40, height: 40 } },
        { kind: "click", t: 3500, x: 401, y: 300, button: "left", bbox: { x: 381, y: 280, width: 40, height: 40 } },
      ],
    };
    const plan = buildMotionPlan(tl, 60);
    const { track } = computeCameraMotion(tl, 60);
    expect(plan.travels).toHaveLength(0);
    expect(plan.shots).toHaveLength(2);
    // Windows abut (no uncovered gap), so the camera holds the zoom rather than
    // lurching out to the wide default (scale 1) between the two shots.
    let minScale = Infinity;
    for (let t = 1700; t <= 3400; t += 50) minScale = Math.min(minScale, cameraAt(track, t).scale);
    expect(minScale).toBeGreaterThan(1.4);
  });
});
