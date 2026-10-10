import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const tscBin = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
// `--types node` resolves @types/node from the cwd, not from the generated file's temp dir.
const coreDir = path.dirname(require.resolve("../package.json"));

/** Type-checks the exact generated file OMP will load, not just its syntax. */
export function typecheckGeneratedExtension(file: string): void {
  const result = spawnSync(
    process.execPath,
    [
      tscBin,
      // TS7 rejects explicit files while a tsconfig.json is present (TS5112).
      "--ignoreConfig",
      "--noEmit",
      "--pretty",
      "false",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--strict",
      "--skipLibCheck",
      "--types",
      "node",
      "--lib",
      "es2022,dom",
      file,
    ],
    { cwd: coreDir, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return;
  throw new Error(`${result.stdout}${result.stderr}`.trim() || `tsc exited ${result.status}`);
}

/**
 * Strips types from a generated extension so a test can execute it. CommonJS
 * output lowers `import()` to `require()`, so a test can serve the extension's
 * dynamic imports through its injected `require` (ADR-0036).
 */
export function transpileGeneratedExtension(source: string, format: "cjs" | "esm"): string {
  return transformSync(source, {
    loader: "ts",
    target: "es2022",
    format,
    supported: format === "cjs" ? { "dynamic-import": false } : undefined,
  }).code;
}
