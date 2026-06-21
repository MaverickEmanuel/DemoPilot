import { describe, it, expect } from "vitest";
import { cursorPressAt } from "../src/interp";
import type { Timeline } from "../src/types";

function tl(events: Timeline["events"]): Timeline {
  return {
    version: 1,
    width: 1280,
    height: 800,
    durationMs: 9000,
    cursor: [{ t: 0, x: 0, y: 0 }],
    events,
  };
}

describe("cursorPressAt (click scale-pop)", () => {
  const t = tl([{ kind: "click", t: 1000, x: 100, y: 100, button: "left" }]);

  it("is 0 away from any click", () => {
    expect(cursorPressAt(t, 0)).toBe(0);
    expect(cursorPressAt(t, 500)).toBe(0);
    expect(cursorPressAt(t, 2000)).toBe(0);
  });

  it("rises to a peak mid-pop and returns to 0 by the end (0→1→0)", () => {
    expect(cursorPressAt(t, 1000)).toBeCloseTo(0, 5); // at the click
    expect(cursorPressAt(t, 1070)).toBeCloseTo(1, 2); // ~70ms in: peak
    expect(cursorPressAt(t, 1140)).toBeCloseTo(0, 5); // 140ms: settled
    // Monotonic into the peak.
    expect(cursorPressAt(t, 1035)).toBeGreaterThan(cursorPressAt(t, 1010));
  });
});
