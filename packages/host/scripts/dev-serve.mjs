#!/usr/bin/env node
// Runs the persistent host from source for development (issue #442 §9):
//
//   npm run dev:serve -w @omp-ui/host -- [--flavor dev-server|dev]
//
// Bundles src/cli-main.ts with esbuild the way package-host.mjs does — same
// externals, same `__HOST_VERSION__` — into dist/dev/cli-main.cjs and runs
// `serve` under plain Node. The flavour selects the data root the way the
// installed binary's does (`resolveDataRoot`, honouring OMP_UI_DATA_DIR):
// `dev-server` is the root the desktop's `npm run dev` connects to, `dev` the
// standalone unpackaged desktop's. The verifier honours OMP_UI_VERIFIER_BROWSER
// and the page built into dist/verifier; unset, it reports degraded, not a
// crash.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, "..");
const repoRoot = path.resolve(hostRoot, "..", "..");
const desktopPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "packages", "desktop", "package.json"), "utf8"));

/** Native addons and their loaders stay external, as in package-host.mjs; here they resolve from node_modules. */
const EXTERNALS = [/^node-pty$/, /^puppeteer-core$/, /^@napi-rs\/keyring$/, /^@primno\/dpapi$/, /\.node$/];

function parseArgs(argv) {
  const out = { flavor: "dev-server" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--flavor") {
      i += 1;
      out.flavor = argv[i];
    } else if (arg.startsWith("--flavor=")) {
      out.flavor = arg.slice("--flavor=".length);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (out.flavor !== "dev" && out.flavor !== "dev-server") {
    throw new Error(`--flavor must be dev or dev-server, got ${JSON.stringify(out.flavor)}`);
  }
  return out;
}

function externalsPlugin() {
  return {
    name: "host-externals",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!isBuiltin(args.path) && !EXTERNALS.some((re) => re.test(args.path))) return null;
        return { path: args.path, external: true, sideEffects: false };
      });
    },
  };
}

async function bundle() {
  const esbuild = await import("esbuild");
  const outfile = path.join(hostRoot, "dist", "dev", "cli-main.cjs");
  await esbuild.build({
    entryPoints: [path.join(hostRoot, "src", "cli-main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    define: {
      __HOST_VERSION__: JSON.stringify(desktopPkg.version),
      // The one `import.meta.url` in the host (the DEK worker entry beside
      // credentials/dek-worker.ts) must keep pointing at the source tree,
      // where dek-worker-entry.cjs and the libsecret addon live.
      "import.meta.url": JSON.stringify(pathToFileURL(path.join(hostRoot, "src", "credentials", "dek-worker.ts")).href),
    },
    plugins: [externalsPlugin()],
    legalComments: "none",
    logLevel: "warning",
  });
  return outfile;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const bundled = await bundle();
  console.log(`[dev-serve] ${args.flavor} host ${desktopPkg.version}`);
  const child = spawn(process.execPath, [bundled, "serve"], {
    stdio: "inherit",
    env: { ...process.env, OMP_UI_HOST_DEV_FLAVOR: args.flavor },
  });
  // Forward the terminal's signals so Ctrl-C reaches the host's graceful stop.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal === null ? 1 : 128));
  });
}

main().catch((err) => {
  console.error(`[dev-serve] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
