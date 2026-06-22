/**
 * build-dist.mjs — assemble the single publishable npm package for DemoPilot.
 *
 *     node scripts/build-dist.mjs       (or: pnpm build:dist)
 *
 * DemoPilot is a pnpm monorepo of three packages (core, compositor, mcp-server)
 * wired together with `workspace:*` deps and run straight from TypeScript via
 * tsx. For npm we ship ONE self-contained package, `demopilot-mcp`, so a user
 * can `npx -y demopilot-mcp` (the stdio MCP server) or `demopilot render …`
 * (the CLI) with no monorepo and no build step on their side.
 *
 * Why vendor the source instead of compiling: Remotion re-bundles the compositor
 * at *render time* (`bundle({ entryPoint })` in packages/compositor/src/render.ts),
 * so the published package MUST contain the compositor's TSX source plus its
 * react/remotion deps — it cannot be tree-shaken/compiled away. The simplest
 * thing that keeps that working is to ship all three packages' source as-is and
 * register the tsx ESM loader at the bin entry (tsx is a real dependency).
 *
 * core + compositor are placed into the artifact's own `node_modules/@demopilot/*`
 * and declared as `bundledDependencies`, so `npm pack` includes them in the
 * tarball and they need not be published separately — the imports stay exactly
 * `@demopilot/core` / `@demopilot/compositor` (no rewriting). All other deps are
 * pinned to the exact versions installed in this workspace (read from disk), so
 * the published package matches what we test here — important for Remotion, which
 * requires every `remotion`/`@remotion/*` package to share one version.
 *
 * Output: ./dist-package/ (a ready-to-pack package dir). Pack it with:
 *     npm pack ./dist-package
 */
import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const out = join(repoRoot, "dist-package");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const rootPkg = readJson(join(repoRoot, "package.json"));
const corePkg = readJson(join(repoRoot, "packages/core/package.json"));
const compositorPkg = readJson(join(repoRoot, "packages/compositor/package.json"));
const mcpPkg = readJson(join(repoRoot, "packages/mcp-server/package.json"));

/** Resolve the version actually installed in the workspace (so the tarball pins
 * exactly what we tested); fall back to the declared range if unresolvable.
 *
 * Resolves the package's entry then walks up to ITS OWN package.json — a plain
 * `resolve(name + "/package.json")` can land on a nested marker file (e.g.
 * `dist/cjs/package.json`) for packages with an `exports` map, which has no
 * version. */
function pinnedVersion(name, declared, fromDir) {
  const req = createRequire(join(fromDir, "package.json"));
  // Try the package entry first, then its `./package.json` subpath — packages
  // with an `exports` map may expose only one of them under `require`.
  for (const spec of [name, `${name}/package.json`]) {
    let dir;
    try {
      dir = dirname(req.resolve(spec));
    } catch {
      continue;
    }
    for (let i = 0; i < 10; i++) {
      const pj = join(dir, "package.json");
      if (existsSync(pj)) {
        const j = JSON.parse(readFileSync(pj, "utf8"));
        if (j.name === name && j.version) return j.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return declared;
}

// Merge the runtime deps of all three packages, dropping the internal workspace
// packages (they're vendored + bundled below). Pin each to its installed version.
const merged = {};
const sources = [
  ["packages/core", corePkg],
  ["packages/compositor", compositorPkg],
  ["packages/mcp-server", mcpPkg],
];
for (const [dir, pkg] of sources) {
  for (const [name, declared] of Object.entries(pkg.dependencies ?? {})) {
    if (name.startsWith("@demopilot/")) continue; // vendored, not an npm dep
    merged[name] = pinnedVersion(name, declared, join(repoRoot, dir));
  }
}
// tsx is the runtime TypeScript loader the bin launchers register.
merged["tsx"] = pinnedVersion("tsx", "^4.19.2", repoRoot);

// Deterministic key order keeps the generated package.json diff-friendly.
const sortedDeps = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));

const distPkg = {
  name: "demopilot-mcp",
  version: rootPkg.version,
  description:
    "Turn a prompt into a polished product-demo MP4 — an MCP server + CLI that drives a browser with Playwright and composites a Screen-Studio-style render with Remotion.",
  license: rootPkg.license ?? "MIT",
  type: "module",
  // demopilot-mcp = the stdio MCP server; demopilot = the standalone CLI.
  bin: {
    "demopilot-mcp": "./bin/demopilot-mcp.mjs",
    demopilot: "./bin/demopilot.mjs",
  },
  engines: { node: ">=20" },
  keywords: [
    "mcp",
    "model-context-protocol",
    "demo",
    "screen-recording",
    "playwright",
    "remotion",
    "video",
    "screencast",
    "product-demo",
  ],
  homepage: "https://github.com/MaverickEmanuel/DemoPilot#readme",
  repository: { type: "git", url: "git+https://github.com/MaverickEmanuel/DemoPilot.git" },
  bugs: { url: "https://github.com/MaverickEmanuel/DemoPilot/issues" },
  // Vendored workspace packages live in this artifact's own node_modules and are
  // bundled into the tarball, so their `@demopilot/*` imports resolve unchanged
  // and they need not be published separately.
  dependencies: { "@demopilot/core": corePkg.version, "@demopilot/compositor": compositorPkg.version, ...sortedDeps },
  bundledDependencies: ["@demopilot/core", "@demopilot/compositor"],
  files: ["bin", "src", "examples", "README.md", "LICENSE"],
};

// ---------------------------------------------------------------------------
// Assemble the artifact.
// ---------------------------------------------------------------------------

/** Recursive copy that skips build/install detritus. */
function copyDir(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => !/[/\\](node_modules|dist|\.turbo|\.git)([/\\]|$)/.test(s),
  });
}

/** Vendor a workspace package as a bundled dependency: its package.json (minus
 * `private`, which would block packing) plus its `src`. */
function vendor(pkgDir, pkg) {
  const dest = join(out, "node_modules", pkg.name);
  mkdirSync(dest, { recursive: true });
  copyDir(join(repoRoot, pkgDir, "src"), join(dest, "src"));
  const { private: _omit, scripts: _s, devDependencies: _d, ...keep } = pkg;
  writeFileSync(join(dest, "package.json"), JSON.stringify(keep, null, 2) + "\n");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// mcp-server source (the bin entrypoints live here: src/index.ts, src/cli.ts).
copyDir(join(repoRoot, "packages/mcp-server/src"), join(out, "src"));
// Vendor + bundle the two workspace deps.
vendor("packages/core", corePkg);
vendor("packages/compositor", compositorPkg);
// Ship the example so users can try a render immediately (seed app + script).
copyDir(join(repoRoot, "examples"), join(out, "examples"));
// Top-level docs/license.
cpSync(join(repoRoot, "README.md"), join(out, "README.md"));
cpSync(join(repoRoot, "LICENSE"), join(out, "LICENSE"));

// ---------------------------------------------------------------------------
// Bin launchers: register the tsx ESM loader, then import the TS entry. tsx is
// a real dependency, so this never shells out to a network install at runtime.
// ---------------------------------------------------------------------------
const launcher = (entry, blurb) => `#!/usr/bin/env node
// ${blurb}
// DemoPilot ships TypeScript source (Remotion re-bundles the compositor sources
// at render time), so register the tsx ESM loader and import the entry. tsx is a
// runtime dependency — this never triggers a network install.
import { register } from "tsx/esm/api";
register();
await import(new URL(${JSON.stringify(entry)}, import.meta.url).href);
`;

mkdirSync(join(out, "bin"), { recursive: true });
const writeBin = (file, content) => {
  const p = join(out, "bin", file);
  writeFileSync(p, content);
  chmodSync(p, 0o755);
};
writeBin("demopilot-mcp.mjs", launcher("../src/index.ts", "DemoPilot stdio MCP server."));
writeBin("demopilot.mjs", launcher("../src/cli.ts", "DemoPilot standalone render CLI."));

writeFileSync(join(out, "package.json"), JSON.stringify(distPkg, null, 2) + "\n");
// npm ignores a bundled package's nested .npmignore but not stray ignore files;
// keep the artifact clean and predictable.
writeFileSync(join(out, ".npmignore"), "# assembled by scripts/build-dist.mjs\n");

console.log(`✓ assembled ${distPkg.name}@${distPkg.version} → ${out}`);
console.log(`  deps: ${Object.keys(distPkg.dependencies).length} (incl. bundled @demopilot/core, @demopilot/compositor)`);
console.log(`  pack it: npm pack ./dist-package`);
