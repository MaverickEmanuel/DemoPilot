// Audio for the rendered demo: a soft music bed + subtle click ticks by default,
// and optional TTS voiceover (opt-in, behind an API key). Everything is mixed in
// Node (full control over timing/ducking/fades) and muxed onto the silent video
// with Remotion's bundled ffmpeg — no system ffmpeg, no external assets.
//
// The music beds and click ticks are SYNTHESIZED from code (like the mesh
// backgrounds in frame.ts are CSS recipes), so they're content-agnostic and
// license-clear by construction — nothing is downloaded or sampled. Beds are
// designed to tile seamlessly (each chord swells from and returns to silence),
// then looped/trimmed to the timeline duration with a global fade in/out.

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Timeline } from "./types.js";
import { resolveBundledFfmpeg, type FfmpegLocation } from "./ffmpeg.js";

const SAMPLE_RATE = 44100;
/** A click that navigates within this window is a transition — skip its tick
 * (mirrors the ripple suppression in interp.ts so audio and overlays agree). */
const NAV_SUPPRESS_MS = 320;

export interface AudioOptions {
  /** Named music bed ("calm" | "warm"), "none" to disable, or undefined = default. */
  music?: string;
  /** Music bed volume (0..1). Default 0.16 — a quiet, unobtrusive bed. */
  musicVolume?: number;
  /** Place subtle click ticks at click events. Default true. */
  sfx?: boolean;
  /** Synthesize TTS voiceover for narrate lines (needs an API key). Default false. */
  voiceover?: boolean;
}

/** True when any audio is requested (and worth resolving ffmpeg for). */
export function wantsAudio(opts: AudioOptions): boolean {
  const music = opts.music ?? "calm";
  const musicOn = music !== "none" && (opts.musicVolume ?? DEFAULT_MUSIC_VOLUME) > 0;
  return musicOn || (opts.sfx ?? true) || (opts.voiceover ?? false);
}

const DEFAULT_MUSIC_VOLUME = 0.16;
const SFX_GAIN = 0.22;
const VOICE_GAIN = 0.92;
/** Bed level under speech; the bed ducks to this while a VO clip plays. */
const DUCK_LEVEL = 0.34;

// ---------------------------------------------------------------------------
// Music beds — synthesized soft pads. A bed is a chord progression; each chord
// swells in and out (sin envelope) so the loop tiles seamlessly at any length.
// ---------------------------------------------------------------------------

interface Bed {
  /** Seconds per chord. */
  chordSec: number;
  /** Chords as note frequencies (Hz). */
  chords: number[][];
  /** Relative gains of harmonic partials (warmth without muddiness). */
  partials: number[];
}

// Note frequencies (Hz) for readable chord spellings.
const N = {
  G3: 196.0, A3: 220.0, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63,
  F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, D5: 587.33,
};

const BEDS: Record<string, Bed> = {
  // Calm (default): a gentle Cmaj7 → Am7 → Fmaj7 → G7 wash, mid-register so it
  // sits under the UI without booming. Soft second/third partials for air.
  calm: {
    chordSec: 4.0,
    chords: [
      [N.C4, N.E4, N.G4, N.B4],
      [N.A3, N.C4, N.E4, N.G4],
      [N.F4, N.A4, N.C5, N.E4],
      [N.G3, N.B3, N.D4, N.F4],
    ],
    partials: [1.0, 0.28, 0.1],
  },
  // Warm: lower, slower Dm9 → Bbmaj7 → Fmaj7 → C wash — rounder and more mellow.
  warm: {
    chordSec: 5.0,
    chords: [
      [N.D4, N.F4, N.A4, N.C5],
      [N.A3, N.D4, N.F4, N.C5],
      [N.F4, N.A4, N.C5, N.D5],
      [N.G3, N.C4, N.E4, N.G4],
    ],
    partials: [1.0, 0.22, 0.06],
  },
};

/** One chord's raw partial sum at absolute time `tAbs` (no envelope). */
function chordSignal(freqs: number[], partials: number[], tAbs: number): number {
  let s = 0;
  for (const f of freqs) {
    for (let h = 0; h < partials.length; h++) {
      const g = partials[h];
      if (g <= 0) continue;
      // A faint detuned twin per partial gives a soft chorus/warmth.
      s += g * (Math.sin(2 * Math.PI * f * (h + 1) * tAbs) +
                0.6 * Math.sin(2 * Math.PI * f * (h + 1) * 1.003 * tAbs));
    }
  }
  return s;
}

/** Synthesizes the music bed into a mono float buffer of `nSamples`, looped and
 * globally faded in/out. Returns silence (zeros) for an unknown/none bed.
 *
 * The chords are blended with overlap-add raised-cosine windows (hop = chordSec,
 * width = 2·chordSec), which satisfy the constant-overlap-add condition: their
 * sum is flat, so the bed crossfades chord→chord at a CONSTANT level (no pumping)
 * while still tiling seamlessly (windows wrap around the loop). */
function synthBed(name: string, nSamples: number): Float32Array {
  const out = new Float32Array(nSamples);
  const bed = BEDS[name];
  if (!bed) return out;
  const nChords = bed.chords.length;
  const loopSec = bed.chordSec * nChords;
  let peak = 1e-6;
  for (let i = 0; i < nSamples; i++) {
    const tAbs = i / SAMPLE_RATE;
    const tLoop = tAbs % loopSec; // seconds within the loop
    let s = 0;
    for (let ci = 0; ci < nChords; ci++) {
      const center = (ci + 0.5) * bed.chordSec;
      // Circular distance to this chord's window center (so the loop wraps).
      let d = Math.abs(tLoop - center);
      d = Math.min(d, loopSec - d);
      if (d >= bed.chordSec) continue; // outside this raised-cosine window
      const w = 0.5 * (1 + Math.cos((Math.PI * d) / bed.chordSec)); // 1 → 0 over chordSec
      s += chordSignal(bed.chords[ci], bed.partials, tAbs) * w;
    }
    out[i] = s;
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  // Normalize the bed's intrinsic peak to ~0.9 (volume is applied at mix time).
  const norm = 0.9 / peak;
  // Global fade in/out so the bed enters and leaves gently.
  const fade = Math.min(Math.round(0.8 * SAMPLE_RATE), Math.floor(nSamples / 2));
  for (let i = 0; i < nSamples; i++) {
    let g = norm;
    if (i < fade) g *= i / fade;
    else if (i > nSamples - fade) g *= (nSamples - i) / fade;
    out[i] *= g;
  }
  return out;
}

/** A short, soft click tick: a quick sine blip with a tiny noise transient. */
function clickTick(): Float32Array {
  const dur = 0.06;
  const n = Math.round(dur * SAMPLE_RATE);
  const buf = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const body = Math.sin(2 * Math.PI * 1500 * t) * Math.exp(-t / 0.012);
    const transient = rnd() * Math.exp(-t / 0.004) * 0.5;
    buf[i] = body + transient;
  }
  return buf;
}

/** Mixes `src` into `dst` at sample offset `at`, scaled by `gain` (clamped later). */
function mixInto(dst: Float32Array, src: Float32Array, at: number, gain = 1): void {
  for (let i = 0; i < src.length; i++) {
    const j = at + i;
    if (j >= 0 && j < dst.length) dst[j] += src[i] * gain;
  }
}

/** Click event times (ms) that are NOT immediately followed by a navigation. */
function nonNavClickTimes(timeline: Timeline): number[] {
  const navs = timeline.events.filter((e) => e.kind === "navigate").map((e) => e.t);
  return timeline.events
    .filter((e) => e.kind === "click")
    .filter((e) => !navs.some((nt) => nt > e.t && nt - e.t <= NAV_SUPPRESS_MS))
    .map((e) => e.t);
}

// ---------------------------------------------------------------------------
// Track assembly
// ---------------------------------------------------------------------------

export interface BuildAudioResult {
  /** Path to the assembled WAV, or null if there is nothing to play. */
  wavPath: string | null;
  /** Whether a TTS voiceover was actually synthesized (vs. skipped). */
  voiceover: boolean;
}

/**
 * Builds the full audio track (music + SFX + optional VO) as a mono 16-bit WAV.
 * Pure synthesis + (for VO only) network TTS and ffmpeg decode. Returns null if
 * the result would be silent.
 */
export async function buildAudioTrack(
  timeline: Timeline,
  opts: AudioOptions,
  ffmpeg: FfmpegLocation,
  workDir: string,
): Promise<BuildAudioResult> {
  await mkdir(workDir, { recursive: true });
  const nSamples = Math.max(1, Math.ceil((timeline.durationMs / 1000) * SAMPLE_RATE));
  const track = new Float32Array(nSamples);

  // 1) Music bed (looped + faded), scaled by volume — with VO ducking applied later.
  const bedName = opts.music ?? "calm";
  const musicVolume = opts.musicVolume ?? DEFAULT_MUSIC_VOLUME;
  const bed = bedName !== "none" && musicVolume > 0 ? synthBed(bedName, nSamples) : new Float32Array(nSamples);

  // 2) Voiceover (opt-in). Synthesize each narrate line, place it at its timestamp,
  //    and duck the bed under it. Skipped silently with no key.
  let didVoiceover = false;
  const duck = new Float32Array(nSamples).fill(1); // bed gain multiplier over time
  if (opts.voiceover) {
    const narrations = timeline.events.filter((e) => e.kind === "narrate") as Array<{ t: number; text: string }>;
    for (const nrt of narrations) {
      const pcm = await synthVoiceClip(nrt.text, ffmpeg, workDir);
      if (!pcm) continue; // no key / failure → skip this line (captions remain)
      didVoiceover = true;
      const at = Math.round((nrt.t / 1000) * SAMPLE_RATE);
      mixInto(track, pcm, at, VOICE_GAIN);
      applyDuck(duck, at, pcm.length);
    }
  }

  // Apply the (possibly ducked) bed.
  for (let i = 0; i < nSamples; i++) track[i] += bed[i] * musicVolume * duck[i];

  // 3) Click ticks.
  if (opts.sfx ?? true) {
    const tick = clickTick();
    for (const tMs of nonNavClickTimes(timeline)) {
      mixInto(track, tick, Math.round((tMs / 1000) * SAMPLE_RATE), SFX_GAIN);
    }
  }

  // Nothing audible? (e.g. music:none + sfx:false + no VO) — return null.
  let hasSignal = false;
  for (let i = 0; i < nSamples; i++) if (track[i] !== 0) { hasSignal = true; break; }
  if (!hasSignal) return { wavPath: null, voiceover: didVoiceover };

  // Soft-limit and write.
  const wavPath = join(workDir, "track.wav");
  await writeFile(wavPath, encodeWav(track));
  return { wavPath, voiceover: didVoiceover };
}

/** Ducks the bed gain toward DUCK_LEVEL over [at, at+len] with short ramps. */
function applyDuck(duck: Float32Array, at: number, len: number): void {
  const ramp = Math.round(0.08 * SAMPLE_RATE);
  const pad = Math.round(0.2 * SAMPLE_RATE); // hold the duck a touch past the clip
  const start = Math.max(0, at - ramp);
  const end = Math.min(duck.length, at + len + pad + ramp);
  for (let i = start; i < end; i++) {
    let target = DUCK_LEVEL;
    if (i < at) target = 1 - (1 - DUCK_LEVEL) * ((i - start) / ramp);
    else if (i > at + len + pad) target = 1 - (1 - DUCK_LEVEL) * ((end - i) / ramp);
    duck[i] = Math.min(duck[i], Math.max(DUCK_LEVEL, target));
  }
}

// ---------------------------------------------------------------------------
// Voiceover (TTS) — opt-in, behind an API key. Returns mono float PCM at
// SAMPLE_RATE, or null when no key is configured or the request fails.
// ---------------------------------------------------------------------------

async function synthVoiceClip(text: string, ffmpeg: FfmpegLocation, workDir: string): Promise<Float32Array | null> {
  const audio = await ttsRequest(text);
  if (!audio) return null;
  // Decode the provider's MP3/Opus to mono 16-bit WAV via ffmpeg, then to float.
  // (Remotion's bundled ffmpeg is a trimmed build with the `wav` muxer but NOT the
  // raw `s16le` muxer, so we go through a WAV container and read its data chunk.)
  const inPath = join(workDir, `vo-${hash(text)}.audio`);
  const wavPath = join(workDir, `vo-${hash(text)}.wav`);
  await writeFile(inPath, audio);
  try {
    await runFfmpeg(ffmpeg, [
      "-y", "-i", inPath,
      "-f", "wav", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(SAMPLE_RATE),
      wavPath,
    ]);
    return decodeWavPcm(await readFile(wavPath));
  } catch {
    return null; // a decode failure shouldn't abort the whole render
  } finally {
    await rm(inPath, { force: true });
    await rm(wavPath, { force: true });
  }
}

/** Reads a mono 16-bit PCM WAV's samples into a Float32Array by locating its
 * `data` chunk (ffmpeg may prepend a LIST/INFO chunk before it). */
function decodeWavPcm(wav: Buffer): Float32Array {
  let off = 12; // skip "RIFF"<size>"WAVE"
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= wav.length) {
    const id = wav.toString("latin1", off, off + 4);
    const sz = wav.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = Math.min(sz, wav.length - dataOff);
      break;
    }
    off += 8 + sz + (sz & 1); // chunks are word-aligned
  }
  if (dataOff < 0) return new Float32Array(0);
  const n = Math.floor(dataLen / 2);
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = wav.readInt16LE(dataOff + i * 2) / 32768;
  return pcm;
}

/** Calls a TTS provider chosen by which API key is set. Returns encoded audio
 * bytes, or null if no provider key is configured (so VO is skipped silently). */
async function ttsRequest(text: string): Promise<Buffer | null> {
  const openai = process.env.OPENAI_API_KEY;
  const eleven = process.env.ELEVENLABS_API_KEY;
  try {
    if (openai) {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${openai}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.DEMOPILOT_TTS_MODEL ?? "gpt-4o-mini-tts",
          voice: process.env.DEMOPILOT_TTS_VOICE ?? "alloy",
          input: text,
          response_format: "mp3",
        }),
      });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
    if (eleven) {
      const voice = process.env.DEMOPILOT_TTS_VOICE ?? "21m00Tcm4TlvDq8ikWAM";
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: "POST",
        headers: { "xi-api-key": eleven, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: process.env.DEMOPILOT_TTS_MODEL ?? "eleven_turbo_v2_5" }),
      });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    }
  } catch {
    return null; // network failure → skip VO, keep captions
  }
  return null; // no key configured
}

// ---------------------------------------------------------------------------
// Mux + ffmpeg helpers
// ---------------------------------------------------------------------------

/** Muxes a WAV audio track onto a (silent) video, re-encoding audio to AAC. */
export async function muxAudio(
  videoPath: string,
  wavPath: string,
  outPath: string,
  ffmpeg: FfmpegLocation,
): Promise<void> {
  await runFfmpeg(ffmpeg, [
    "-y",
    "-i", videoPath,
    "-i", wavPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    outPath,
  ]);
}

export { resolveBundledFfmpeg };

/** 16-bit PCM mono WAV from a float buffer (soft-clipped to [-1, 1]). */
function encodeWav(samples: Float32Array): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
  return h.toString(36);
}

function runFfmpeg(ffmpeg: FfmpegLocation, args: string[]): Promise<void> {
  const libVar =
    process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : process.platform === "win32" ? "PATH" : "LD_LIBRARY_PATH";
  const prev = process.env[libVar];
  const env = { ...process.env, [libVar]: prev ? `${ffmpeg.libDir}:${prev}` : ffmpeg.libDir };
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.bin, args, { env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}:\n${stderr.split("\n").slice(-6).join("\n")}`)),
    );
  });
}

// Exposed for tests: deterministic synthesis pieces.
export const __test = { synthBed, clickTick, nonNavClickTimes, encodeWav, SAMPLE_RATE };
