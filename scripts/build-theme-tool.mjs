#!/usr/bin/env node
// Bundles the theme repository tool (#1213) into one plain-Node file the
// official theme repository commits under tools/ and runs in CI.
// Usage: node scripts/build-theme-tool.mjs <out-file>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromHere = createRequire(import.meta.url);

/** Resolve esbuild as packages/host-lite/scripts/bundle-session.mjs does: host-lite first, then the repo root. */
function loadEsbuild() {
  for (const from of [path.join(repoRoot, "packages/host-lite"), repoRoot]) {
    try {
      return requireFromHere(requireFromHere.resolve("esbuild", { paths: [from] }));
    } catch {
      // try the next root
    }
  }
  console.error("[build-theme-tool] esbuild is not resolvable from packages/host-lite or the repo root; run `npm install`.");
  process.exit(1);
}

const outfile = process.argv[2];
if (outfile === undefined || process.argv.length > 3) {
  console.error("usage: node scripts/build-theme-tool.mjs <out-file>");
  process.exit(2);
}

const { version } = JSON.parse(readFileSync(path.join(repoRoot, "packages/desktop/package.json"), "utf8"));
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

await loadEsbuild().build({
  stdin: {
    contents: [
      'import { runThemeRepositoryCli } from "./packages/core/src/theme-repository-cli.ts";',
      "process.exitCode = await runThemeRepositoryCli(process.argv.slice(2), {",
      "  out: (line) => console.log(line),",
      "  err: (line) => console.error(line),",
      "});",
    ].join("\n"),
    resolveDir: repoRoot,
    sourcefile: "omp-ui-theme-tool-entry.mjs",
    loader: "js",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.resolve(outfile),
  banner: {
    js: `// omp-ui theme repository tool. Built from LankfordAI/omp-ui ${version} (${commit}). Do not edit.`,
  },
  logLevel: "warning",
});
console.log(`wrote ${outfile}`);
