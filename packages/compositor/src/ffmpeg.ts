import { createRequire } from "node:module";
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
  try {
    const here = createRequire(import.meta.url);
    const rendererReq = createRequire(here.resolve("@remotion/renderer"));
    const pkg = compositorPackage(rendererReq);
    const dir = dirname(rendererReq.resolve(`${pkg}/package.json`));
    const bin = process.platform === "win32" ? `${dir}\\ffmpeg.exe` : `${dir}/ffmpeg`;
    if (!existsSync(bin)) return null;
    return { bin, libDir: dir };
  } catch {
    return null;
  }
}
