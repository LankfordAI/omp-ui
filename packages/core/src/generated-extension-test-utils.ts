import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

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
