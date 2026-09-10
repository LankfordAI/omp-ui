#!/usr/bin/env node
// Smoke-tests the archive scripts/package-host.mjs produced (issue #442
// §10.6): unpacks it somewhere fresh and runs the executable the way an
// installer would, proving the SEA boots, the CLI's control path works against
// an empty data root, and the shipped node-pty addon loads under the packaged
// runtime's ABI. Exits non-zero on the first failure.
//
//   node scripts/smoke-package.mjs [--lane <lane>] [--out dist/host] [--artifact <file>] [--skip-node-pty]
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(hostRoot, "package.json"), "utf8"));

/** Mirrors package-host.mjs: lane → platform/arch and archive suffix. */
const LANES = {
  "linux-x64": { platform: "linux", arch: "x64", archive: "tar.gz" },
  "mac-x64": { platform: "darwin", arch: "x64", archive: "zip" },
  "mac-arm64": { platform: "darwin", arch: "arm64", archive: "zip" },
  "win-x64": { platform: "win32", arch: "x64", archive: "zip" },
};

/** `status` with neither a host record nor an owner lock (cli.ts EXIT.ABSENT). */
const EXIT_ABSENT = 3;
const STEP_TIMEOUT_MS = 30_000;

function currentLane() {
  const key = `${process.platform}/${process.arch}`;
  const found = Object.entries(LANES).find(([, l]) => `${l.platform}/${l.arch}` === key);
  if (found === undefined) throw new Error(`no host lane for ${key}`);
  return found[0];
}

function parseArgs(argv) {
  const out = { lane: null, out: path.join(hostRoot, "dist", "host"), artifact: null, skipNodePty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--lane") out.lane = next();
    else if (arg.startsWith("--lane=")) out.lane = arg.slice("--lane=".length);
    else if (arg === "--out") out.out = path.resolve(next());
    else if (arg.startsWith("--out=")) out.out = path.resolve(arg.slice("--out=".length));
    else if (arg === "--artifact") out.artifact = path.resolve(next());
    else if (arg.startsWith("--artifact=")) out.artifact = path.resolve(arg.slice("--artifact=".length));
    else if (arg === "--skip-node-pty") out.skipNodePty = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  out.lane ??= currentLane();
  if (!(out.lane in LANES)) throw new Error(`unknown lane ${out.lane}; one of ${Object.keys(LANES).join(", ")}`);
  const lane = LANES[out.lane];
  if (lane.platform !== process.platform || lane.arch !== process.arch) {
    throw new Error(`lane ${out.lane} runs only on ${lane.platform}/${lane.arch} (this is ${process.platform}/${process.arch})`);
  }
  out.artifact ??= path.join(out.out, `omp-ui-host-${pkg.version}-${out.lane}.${lane.archive}`);
  return out;
}

function exec(bin, args, env) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (result.error) throw new Error(`${path.basename(bin)} ${args.join(" ")}: ${result.error.message}`);
  return result;
}

function describe(result) {
  return `exit ${result.status ?? `signal ${result.signal}`}\nstdout: ${JSON.stringify(result.stdout)}\nstderr: ${JSON.stringify(result.stderr)}`;
}

/** Each check throws with the process output on failure so the log names what broke. */
const CHECKS = [
  {
    name: "--version prints the packaged version",
    run(bin) {
      const result = exec(bin, ["--version"], {});
      if (result.status !== 0 || result.stdout.trim() !== pkg.version) {
        throw new Error(`expected exit 0 and "${pkg.version}", got ${describe(result)}`);
      }
    },
  },
  {
    name: "status --json against an empty data root reports absent",
    run(bin, scratch) {
      const dataRoot = path.join(scratch, "data");
      fs.mkdirSync(dataRoot);
      const result = exec(bin, ["status", "--json"], { OMP_UI_DATA_DIR: dataRoot });
      let status;
      try {
        status = JSON.parse(result.stdout);
      } catch {
        throw new Error(`stdout is not JSON: ${describe(result)}`);
      }
      if (result.status !== EXIT_ABSENT || status?.state !== "absent") {
        throw new Error(`expected exit ${EXIT_ABSENT} and state "absent", got ${describe(result)}`);
      }
    },
  },
  {
    name: "lib/node-pty loads inside the executable",
    skip: (args) => args.skipNodePty,
    run(bin) {
      const result = exec(bin, ["--smoke-node-pty"], {});
      if (result.status !== 0 || result.stdout.trim() !== "ok") {
        throw new Error(`expected exit 0 and "ok", got ${describe(result)}`);
      }
    },
  },
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.artifact)) {
    throw new Error(`${args.artifact} does not exist; run scripts/package-host.mjs first or pass --artifact`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-host-smoke-"));
  try {
    const unpacked = path.join(scratch, "unpacked");
    fs.mkdirSync(unpacked);
    // tar reads both formats: GNU tar the tarball, bsdtar (macOS, Windows 10+) the zip too.
    const untar = spawnSync("tar", ["-xf", args.artifact, "-C", unpacked], { stdio: "inherit" });
    if (untar.error) throw new Error(`tar: ${untar.error.message}`);
    if (untar.status !== 0) throw new Error(`tar -xf ${args.artifact} exited ${untar.status}`);

    const bin = path.join(unpacked, pkg.version, "bin", process.platform === "win32" ? "omp-ui.exe" : "omp-ui");
    if (!fs.existsSync(bin)) throw new Error(`${args.artifact} has no ${pkg.version}/bin/${path.basename(bin)}`);
    process.stdout.write(`unpacked ${path.basename(args.artifact)} → ${unpacked}\n`);

    let failed = 0;
    for (const check of CHECKS) {
      if (check.skip?.(args)) {
        process.stdout.write(`skip  ${check.name} (--skip-node-pty)\n`);
        continue;
      }
      try {
        check.run(bin, scratch);
        process.stdout.write(`ok    ${check.name}\n`);
      } catch (err) {
        failed += 1;
        process.stdout.write(`FAIL  ${check.name}\n      ${(err instanceof Error ? err.message : String(err)).replace(/\n/g, "\n      ")}\n`);
      }
    }
    if (failed > 0) throw new Error(`${failed} of ${CHECKS.length} smoke checks failed`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
