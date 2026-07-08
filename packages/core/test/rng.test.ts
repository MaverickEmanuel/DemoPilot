import { describe, it, expect } from "vitest";
import { mulberry32, hashSeed } from "../src/rng.js";

describe("seeded PRNG (deterministic dwell jitter)", () => {
  it("produces an identical sequence for the same seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 16 }, () => a());
    const seqB = Array.from({ length: 16 }, () => b());
    expect(seqA).toEqual(seqB);
    // ...and stays in [0, 1).
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1);
  });

  it("diverges for different seeds", () => {
    const a = Array.from({ length: 8 }, mulberry32(1));
    const b = Array.from({ length: 8 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it("hashSeed is stable and script-name-specific", () => {
    expect(hashSeed("Sign up demo")).toBe(hashSeed("Sign up demo"));
    expect(hashSeed("Sign up demo")).not.toBe(hashSeed("Other demo"));
  });

  it("gives two same-seed dwell sequences an identical rhythm", () => {
    // Mirrors dwell()'s jitter draw: ms - j + rng()*2j. Same seed ⇒ same rhythm.
    const dwellDurations = (seed: number) => {
      const rng = mulberry32(seed);
      return [450, 450, 700, 450].map((ms) => {
        const j = ms * 0.15;
        return ms - j + rng() * 2 * j;
      });
    };
    const seed = hashSeed("Sign up and create your first project");
    expect(dwellDurations(seed)).toEqual(dwellDurations(seed));
  });
});
