/**
 * The host binary's entrypoint (issue #442 §9): what `scripts/package-host.mjs`
 * bundles into the single-executable and what `scripts/dev-serve.mjs` bundles
 * for a development run. It only composes — every dependency `runCli` takes is
 * the real one here, so `cli.ts` stays a pure function of its inputs and this
 * file has nothing worth unit-testing. The SEA is the product; there is no
 * npm `bin`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { readHostRecord, type BuildFlavor } from "@omp-ui/core";
import { connectInstanceClient } from "@omp-ui/server";
import { readOwnerRecord } from "./authority/lock";
import { defaultIsDesktopInstalled, defaultLaunchDesktop, runCli, type CliIo } from "./cli";
import { serve, type ServeOptions } from "./serve";
import { selectSupervisor, type RunResult } from "./supervisor";

/**
 * `bin/omp-ui --smoke-node-pty`: proves the shipped `lib/node-pty` addon loads
 * under the executable's own Node ABI. Hidden — `smoke-package.mjs` is its
 * only caller — and handled here because `runCli` rejects unknown flags.
 */
const SMOKE_NODE_PTY = "--smoke-node-pty";
const SMOKE_CREDENTIAL_BINDING = "--smoke-credential-binding";

/**
 * Set by `scripts/dev-serve.mjs` to `dev` or `dev-server`: the bundle runs from
 * `packages/host/dist/dev/` against the repository's own build outputs instead
 * of the installed layout. Anything else — the SEA never sets it — is the
 * installed flavour.
 */
const DEV_FLAVOR_ENV = "OMP_UI_HOST_DEV_FLAVOR";

const execFileAsync = promisify(execFile);

/** Supervisor commands report through their exit code; a spawn failure is code 1 with the error as stderr. */
async function run(cmd: string, args: readonly string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "utf8", windowsHide: true });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message,
    };
  }
}

function smokeNodePty(): number {
  // The SEA's own `require` loads builtins only; a real one rooted at the
  // executable reaches `<install>/lib/node-pty` the packager laid out.
  const req = createRequire(process.execPath);
  const dir = path.join(path.dirname(process.execPath), "..", "lib", "node-pty");
  const pty = req(dir) as { spawn?: unknown };
  if (typeof pty.spawn !== "function") {
    process.stderr.write("node-pty loaded but exports no spawn()\n");
    return 1;
  }
  // Windows loads its addon on the first spawn, not at require time (issue
  // #474), so ask node-pty's own loader for it the way a spawn would.
  const utils = req(path.join(dir, "lib", "utils")) as { loadNativeModule: (name: string) => unknown };
  utils.loadNativeModule(process.platform === "win32" ? "conpty" : "pty");
  process.stdout.write("ok\n");
  return 0;
}

function smokeCredentialBinding(): number {
  const req = createRequire(process.execPath);
  const lib = path.join(path.dirname(process.execPath), "..", "lib");
  if (process.platform === "linux") {
    const binding = req(path.join(lib, "linux-secret-service", "index.cjs")) as { probe?: unknown };
    if (typeof binding.probe !== "function") throw new Error("Linux credential binding exports no probe()");
    binding.probe();
  } else if (process.platform === "darwin") {
    const binding = req(path.join(lib, "@napi-rs", "keyring")) as { Entry?: unknown };
    if (typeof binding.Entry !== "function") throw new Error("macOS credential binding exports no Entry constructor");
  } else if (process.platform === "win32") {
    const binding = req(path.join(lib, "@primno", "dpapi")) as {
      Dpapi?: { protectData?: unknown; unprotectData?: unknown };
    };
    if (typeof binding.Dpapi?.protectData !== "function" || typeof binding.Dpapi.unprotectData !== "function") {
      throw new Error("Windows credential binding exports no callable Dpapi protectData/unprotectData");
    }
  } else {
    throw new Error(`unsupported credential binding platform ${process.platform}`);
  }
  process.stdout.write("ok\n");
  return 0;
}

const io: CliIo = {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
  env: process.env,
  platform: process.platform,
  home: os.homedir(),
};

/** Where this build's payloads live and how `serve` is composed over them. */
interface Layout {
  flavor: BuildFlavor;
  serveOptions: (dataRoot: string) => Omit<ServeOptions, "dataRoot">;
}

/** `<install>/resources`, beside the executable's `bin/`: the packager's layout (§10.1). */
function installedLayout(): Layout {
  const resourcesDir = path.join(path.dirname(process.execPath), "..", "resources");
  return {
    flavor: "installed",
    serveOptions: (dataRoot) => ({
      hostVersion: __HOST_VERSION__,
      flavor: "installed",
      webRoot: path.join(resourcesDir, "web"),
      verifier: {
        resourcesDir,
        packaged: true,
        runtimeDir: path.join(dataRoot, "runtime"),
        pageDir: path.join(resourcesDir, "verifier-page"),
      },
      // Migration runs only on a live Electron instance's cutover note.
      legacyUserData: null,
    }),
  };
}

/**
 * A development run: the browser bundle from `packages/desktop/out/web` when
 * it has been built (else the transport alone), the verifier page from
 * `packages/host/dist/verifier`, and the browser named by
 * `OMP_UI_VERIFIER_BROWSER` (unset → the verifier degrades, never crashes).
 * `packages/host/dist/dev/cli-main.cjs` is the bundle's location, so the
 * repository root is three levels up.
 */
function devLayout(flavor: "dev" | "dev-server"): Layout {
  const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
  const hostRoot = path.join(repoRoot, "packages", "host");
  const webRoot = path.join(repoRoot, "packages", "desktop", "out", "web");
  return {
    flavor,
    serveOptions: (dataRoot) => ({
      hostVersion: __HOST_VERSION__,
      flavor,
      webRoot: fs.existsSync(webRoot) ? webRoot : "",
      verifier: {
        resourcesDir: path.join(hostRoot, "resources"),
        packaged: false,
        runtimeDir: path.join(dataRoot, "runtime"),
        pageDir: path.join(hostRoot, "dist", "verifier"),
      },
      legacyUserData: null,
    }),
  };
}

function main(argv: string[]): Promise<number> {
  if (argv[0] === SMOKE_NODE_PTY) return Promise.resolve(smokeNodePty());
  if (argv[0] === SMOKE_CREDENTIAL_BINDING) return Promise.resolve(smokeCredentialBinding());
  const devFlavor = process.env[DEV_FLAVOR_ENV];
  const layout =
    devFlavor === "dev" || devFlavor === "dev-server" ? devLayout(devFlavor) : installedLayout();
  return runCli(argv, io, {
    version: __HOST_VERSION__,
    flavor: layout.flavor,
    now: () => Date.now(),
    serve: ({ dataRoot }) => serve({ dataRoot, ...layout.serveOptions(dataRoot) }),
    readHostRecord,
    readLock: readOwnerRecord,
    connect: connectInstanceClient,
    supervisor: (cliIo) => selectSupervisor({ run, home: cliIo.home, platform: cliIo.platform }),
    launchDesktop: defaultLaunchDesktop,
    isDesktopInstalled: defaultIsDesktopInstalled,
  });
}

// A CommonJS bundle (the SEA's only format) has no top-level await.
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`omp-ui: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
