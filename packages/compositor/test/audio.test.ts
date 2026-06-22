import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAudioTrack, wantsAudio, __test } from "../src/audio";
import type { Timeline } from "../src/types";

const { synthBed, clickTick, nonNavClickTimes, SAMPLE_RATE } = __test;

function timeline(events: Timeline["events"], durationMs = 4000): Timeline {
  return { version: 1, width: 1280, height: 800, durationMs, cursor: [{ t: 0, x: 0, y: 0 }], events };
}

/** RMS of a 40ms window of mono s16le PCM starting at sample offset `at`. */
function windowRms(pcm: Buffer, at: number): number {
  const n = Math.round(0.04 * SAMPLE_RATE);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const j = (at + i) * 2;
    if (j + 1 < pcm.length) {
      const v = pcm.readInt16LE(j) / 32768;
      sum += v * v;
    }
  }
  return Math.sqrt(sum / n);
}

describe("audio synthesis", () => {
  it("synthesizes a non-silent bed and silence for none/unknown", () => {
    const n = SAMPLE_RATE * 2;
    const calm = synthBed("calm", n);
    const warm = synthBed("warm", n);
    const none = synthBed("none", n);
    expect(Math.max(...calm.map(Math.abs))).toBeGreaterThan(0.3);
    expect(Math.max(...warm.map(Math.abs))).toBeGreaterThan(0.3);
    expect(Math.max(...none.map(Math.abs))).toBe(0);
    // Seamless-loop design: the bed starts and ends near silence (faded).
    expect(Math.abs(calm[0])).toBeLessThan(0.05);
    expect(Math.abs(calm[n - 1])).toBeLessThan(0.05);
  });

  it("makes a short, decaying click tick", () => {
    const tick = clickTick();
    expect(tick.length).toBeGreaterThan(0.05 * SAMPLE_RATE);
    // Front-loaded energy; tail is much quieter than the head.
    const head = Math.abs(tick[10]);
    const tail = Math.abs(tick[tick.length - 1]);
    expect(head).toBeGreaterThan(tail * 3);
  });

  it("suppresses ticks on clicks that immediately navigate (mirrors the ripple rule)", () => {
    const tl = timeline([
      { kind: "click", t: 1000, x: 10, y: 10, button: "left" },
      { kind: "click", t: 2000, x: 20, y: 20, button: "left" },
      { kind: "navigate", t: 2100, url: "x" }, // within 320ms of the 2000 click
    ]);
    expect(nonNavClickTimes(tl)).toEqual([1000]);
  });

  it("wantsAudio reflects the music+SFX-on-by-default contract", () => {
    expect(wantsAudio({})).toBe(true); // music+SFX default on
    expect(wantsAudio({ music: "none", sfx: false })).toBe(false);
    expect(wantsAudio({ music: "none", sfx: false, voiceover: true })).toBe(true);
  });
});

describe("buildAudioTrack (music + SFX, no voiceover)", () => {
  it("places a click tick at non-navigating clicks and not at navigating ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dp-audio-test-"));
    try {
      const tl = timeline([
        { kind: "click", t: 1000, x: 10, y: 10, button: "left" }, // → tick
        { kind: "click", t: 2000, x: 20, y: 20, button: "left" }, // navigates → no tick
        { kind: "navigate", t: 2100, url: "x" },
      ]);
      // music:none isolates the SFX so the energy test is unambiguous.
      const { wavPath } = await buildAudioTrack(tl, { music: "none", sfx: true }, { bin: "", libDir: "" }, dir);
      expect(wavPath).toBeTruthy();
      const pcm = (await readFile(wavPath!)).subarray(44); // skip the WAV header
      const at = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE);
      const tickRms = windowRms(pcm, at(1000));
      const navRms = windowRms(pcm, at(2000));
      const quietRms = windowRms(pcm, at(500));
      expect(tickRms).toBeGreaterThan(0.01); // audible tick at the real click
      expect(navRms).toBeLessThan(tickRms / 5); // suppressed at the navigating click
      expect(quietRms).toBeLessThan(tickRms / 5); // silent where nothing happens
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns no track when everything is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dp-audio-test-"));
    try {
      const tl = timeline([{ kind: "click", t: 1000, x: 10, y: 10, button: "left" }]);
      const { wavPath } = await buildAudioTrack(tl, { music: "none", sfx: false }, { bin: "", libDir: "" }, dir);
      expect(wavPath).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
