#!/usr/bin/env node
/* global console, process */
/**
 * Bundle the desktop session cluster for the headless lite member (issue #1010).
 *
 * One entry — src/session-bundle/entry.ts, which imports the REAL
 * packages/desktop session-manager.ts — bundled through every workspace
 * package source with esbuild. No desktop file is edited and no source is
 * forked: lite always ships what main ships.
 *
 * The drift gate has three layers:
 * 1. File swap. The verified runtime-Electron leaf of the closure —
 *    browser-pane-contents.ts, reached only by `await import()` from
 *    browser-pane-host.ts — resolves to its shim under shims/ instead.
 * 2. Deny-all electron. The bare `electron` specifier resolves NOWHERE: any
 *    importer fails the build naming itself. A new runtime electron import
 *    appearing in the cluster therefore FAILS THE BUNDLE LOUDLY on the day it
 *    lands — that failure is the drift signal; run this script in CI. When it
 *    fires: add a shim + README row, keep the desktop import type-only, or cut
 *    the feature from lite. Never widen this to `external: ["electron"]`.
 * 3. Metafile rescan. After a green build, every bundled input is re-scanned
 *    for runtime electron text — catches reaches that never consulted the
 *    resolver (e.g. a rewrite of a specifier into the bundle).
 *
 * Externals (resolved from the app tree's node_modules at run time): node-pty
 * (native addon — never inlined), ws and js-yaml (pure JS; keeping the single
 * installed copy preserves class identity with the rest of the install). Node
 * built-ins stay external by platform.
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "../..");
const requireFromHere = createRequire(import.meta.url);

/** Resolve esbuild: this package's dep first, then any hoisted copy. */
function loadEsbuild() {
  for (const from of [pkgRoot, repoRoot]) {
    try {
      return requireFromHere(requireFromHere.resolve("esbuild", { paths: [from] }));
    } catch {
      // try the next root
    }
  }
  console.error(
    "[bundle-session] esbuild is not resolvable from packages/host-lite or the repo root; run `npm install`.",
  );
  process.exit(1);
}

/** Desktop sources whose real implementation needs Electron → headless shim.
 *  The closure audit (esbuild metafile over session-manager.ts, 215 inputs)
 *  found exactly one runtime importer of `electron`. Keep this map's keys as
 *  repo-relative paths; the README table mirrors it. */
const ELECTRON_FILE_SHIMS = {
  "packages/desktop/src/main/browser-pane-contents.ts": "src/session-bundle/shims/browser-pane-contents.ts",
};

function safeRealpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

const SHIM_TARGETS = new Map(
  Object.entries(ELECTRON_FILE_SHIMS).map(([from, to]) => [safeRealpath(path.join(repoRoot, from)), path.join(pkgRoot, to)]),
);

function describeImporter(importer) {
  if (!importer) return "a non-file importer";
  const rel = path.relative(repoRoot, importer);
  return rel.startsWith("..") ? importer : rel;
}

/** The gate's resolver: swap shimmed desktop files, refuse every `electron`. */
function electronGate() {
  return {
    name: "electron-drift-gate",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === "electron") {
          return {
            errors: [
              {
                text:
                  `electron-drift-gate: ${describeImporter(args.importer)} reaches runtime electron, which a headless lite member can not ship. ` +
                  "If the session cluster grew a window-bound leaf: add a shim under src/session-bundle/shims/ plus its README row; keep the " +
                  "desktop import type-only; or cut the feature from lite. Never externalize electron here.",
                location: args.importer ? { file: args.importer, lineText: args.importer } : undefined,
              },
            ],
          };
        }
        if (!args.importer || !args.path.startsWith(".")) return undefined;
        // A relative spec that lands on a shimmed desktop file resolves to the shim.
        const candidate = safeRealpath(path.resolve(args.importer, "..", args.path) + ".ts");
        const plain = safeRealpath(path.resolve(args.importer, "..", args.path));
        const shim = SHIM_TARGETS.get(candidate) ?? SHIM_TARGETS.get(plain);
        return shim === undefined ? undefined : { path: shim };
      });
    },
  };
}

/** Layer 3: runtime electron text inside a bundled input (post-build scan). */
const RUNTIME_ELECTRON_TEXT = /from\s+["']electron["']|require\(\s*["']electron["']\s*\)|import\(\s*["']electron["']\s*\)/;

/**
 * @typedef {object} BuildOptions
 * @property {string[]} [extraEntries] Extra entry points added to the graph —
 *   the tests drop fixtures into it (the `import "electron"` drift leaf, a
 *   direct importer of browser-pane-contents) and assert the gate's behavior.
 * @property {string|null} [outfile] Redirect output; default
 *   packages/host-lite/dist/session-bundle.mjs. The CLI leaves it unset.
 */

/**
 * Build the lite session bundle.
 * @param {BuildOptions} [options]
 */
export async function build({ extraEntries = [], outfile = null } = {}) {
  const esbuild = loadEsbuild();
  const target = outfile ?? path.join(pkgRoot, "dist/session-bundle.mjs");

  const result = await esbuild.build({
    entryPoints: [path.join(pkgRoot, "src/session-bundle/entry.ts"), ...extraEntries],
    ...(extraEntries.length === 0 ? { outfile: target } : { outdir: path.dirname(target) }),
    bundle: true,
    platform: "node",
    format: "esm",
    absWorkingDir: repoRoot,
    target: "node22",
    sourcemap: true,
    // Workspace sources (@omp-ui/core, @omp-ui/server) bundle IN — their
    // published exports are raw .ts a plain-Node host can not load. Only real
    // node_modules leaves stay external (see header). electron is NOT here:
    // the gate plugin refuses it; that refusal is the drift signal.
    external: ["node-pty", "ws", "js-yaml"],
    plugins: [electronGate()],
    metafile: true,
    logLevel: "silent",
  });

  const offenders = [];
  for (const input of Object.keys(result.metafile.inputs)) {
    const absInput = path.resolve(repoRoot, input);
    if (absInput.includes(`${path.sep}session-bundle${path.sep}shims${path.sep}`)) continue;
    let src;
    try {
      src = fs.readFileSync(absInput, "utf8");
    } catch {
      continue;
    }
    if (RUNTIME_ELECTRON_TEXT.test(src)) offenders.push(input);
  }
  if (offenders.length > 0) {
    throw new Error(`electron-drift-gate: bundled inputs still reference runtime electron: ${offenders.join(", ")}`);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === safeRealpath(process.argv[1])) {
  const started = Date.now();
  try {
    const result = await build();
    const outputs = Object.entries(result.metafile.outputs);
    const [output, info] = outputs.find(([p]) => !p.endsWith(".map")) ?? outputs[0];
    console.log(
      `[bundle-session] ${output} (${(info.bytes / 1024).toFixed(0)} KiB, ` +
        `${Object.keys(result.metafile.inputs).length} inputs, electron external: false) in ${Date.now() - started} ms`,
    );
  } catch (err) {
    for (const e of err.errors ?? []) console.error(`[bundle-session] ${e.text}`);
    if (!err.errors) console.error(`[bundle-session] ${err.message}`);
    process.exit(1);
  }
}
