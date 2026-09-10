/**
 * The host binary's entrypoint (issue #442 §10.6): what `scripts/package-host.mjs`
 * bundles into the single-executable. It only composes — every dependency
 * `runCli` takes is the real one here, so `cli.ts` stays a pure function of
 * its inputs and this file has nothing worth unit-testing. Release P ships no
 * `bin` for it; the bundle is the only consumer.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { connectInstanceClient } from "@omp-ui/server";
import { readOwnerRecord } from "./authority/lock";
import { defaultIsDesktopInstalled, defaultLaunchDesktop, runCli, type CliIo } from "./cli";
import { readHostRecord } from "./control/connection-record";
import { serve } from "./serve";
import { selectSupervisor, type RunResult } from "./supervisor";

/** `<install>/resources`, beside the executable's `bin/`: the packager's layout. */
const resourcesDir = path.join(path.dirname(process.execPath), "..", "resources");

/**
 * `bin/omp-ui --smoke-node-pty`: proves the shipped `lib/node-pty` addon loads
 * under the executable's own Node ABI. Hidden — `smoke-package.mjs` is its
 * only caller — and handled here because `runCli` rejects unknown flags.
 */
const SMOKE_NODE_PTY = "--smoke-node-pty";

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
  const pty = req(path.join(path.dirname(process.execPath), "..", "lib", "node-pty")) as {
    spawn?: unknown;
  };
  if (typeof pty.spawn !== "function") {
    process.stderr.write("node-pty loaded but exports no spawn()\n");
    return 1;
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

function main(argv: string[]): Promise<number> {
  if (argv[0] === SMOKE_NODE_PTY) return Promise.resolve(smokeNodePty());
  return runCli(argv, io, {
    version: __HOST_VERSION__,
    flavor: "installed",
    now: () => Date.now(),
    serve: ({ dataRoot }) =>
      serve({
        dataRoot,
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
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
