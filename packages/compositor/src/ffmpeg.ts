import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Location of the ffmpeg binary that Remotion bundles, plus the directory its
 * shared libraries live in (needed on the dynamic-library search path when
 * spawning it). Core's CDP-screencast capture uses this to assemble frames
 * without requiring a system ffmpeg — the same binary Remotion renders with.
 */
export interface FfmpegLocation {
  /** Absolute path to the ffmpeg executable. */
  bin: string;
  /** Directory holding ffmpeg's shared libraries (set on DYLD/LD_LIBRARY_PATH). */
  libDir: string;
}

/** The platform-specific `@remotion/compositor-*` package that ships ffmpeg. */
function compositorPackage(resolveFrom: NodeRequire): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `@remotion/compositor-darwin-${arch}`;
  if (process.platform === "win32") return `@remotion/compositor-win32-x64-msvc`;
  if (process.platform === "linux") {
    // Prefer glibc, fall back to musl (Alpine).
    for (const libc of ["gnu", "musl"]) {
      const name = `@remotion/compositor-linux-${arch}-${libc}`;
      try {
        resolveFrom.resolve(`${name}/package.json`);
        return name;
      } catch {
        /* try the next libc */
      }
    }
    return `@remotion/compositor-linux-${arch}-gnu`;
  }
  throw new Error(`Unsupported platform for bundled ffmpeg: ${process.platform}/${process.arch}`);
}

/**
 * Resolves Remotion's bundled ffmpeg, or null if it can't be located. The
 * `@remotion/compositor-*` packages are optional deps of `@remotion/renderer`,
 * so we anchor resolution at the renderer (resolvable from this package).
 */
export function resolveBundledFfmpeg(): FfmpegLocation | null {
  return resolveBundledBinary("ffmpeg");
}

/**
 * Resolves Remotion's bundled ffprobe (co-located with ffmpeg in the same
 * compositor package), or null if it can't be located.
 */
export function resolveBundledFfprobe(): FfmpegLocation | null {
  return resolveBundledBinary("ffprobe");
}

function resolveBundledBinary(name: "ffmpeg" | "ffprobe"): FfmpegLocation | null {
  try {
    const here = createRequire(import.meta.url);
    const rendererReq = createRequire(here.resolve("@remotion/renderer"));
    const pkg = compositorPackage(rendererReq);
    const dir = dirname(rendererReq.resolve(`${pkg}/package.json`));
    const bin = process.platform === "win32" ? `${dir}\\${name}.exe` : `${dir}/${name}`;
    if (!existsSync(bin)) return null;
    return { bin, libDir: dir };
  } catch {
    return null;
  }
}

/** Env var the platform uses for the dynamic-library search path. */
const LIB_PATH_ENV =
  process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : process.platform === "win32" ? "PATH" : "LD_LIBRARY_PATH";

/**
 * Reads a video's pixel dimensions with the bundled ffprobe. Returns null if
 * ffprobe is unavailable or the probe fails — callers treat that as "unknown"
 * rather than an error, so a missing probe never blocks a valid export.
 */
export function probeVideoDimensions(videoPath: string): { width: number; height: number } | null {
  const probe = resolveBundledFfprobe();
  if (!probe) return null;
  try {
    const existing = process.env[LIB_PATH_ENV];
    const result = spawnSync(
      probe.bin,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        videoPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, [LIB_PATH_ENV]: existing ? `${probe.libDir}:${existing}` : probe.libDir },
      },
    );
    if (result.status !== 0 || !result.stdout) return null;
    const match = result.stdout.trim().match(/^(\d+)x(\d+)/);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return null;
  }
}
