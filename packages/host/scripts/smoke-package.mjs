#!/usr/bin/env node
// Smoke-tests the archive scripts/package-host.mjs produced (issue #442 §12):
// unpacks it somewhere fresh and runs the executable the way an installer
// would, proving the SEA boots, the CLI's control path works against an empty
// data root, the shipped node-pty addon loads under the packaged runtime's ABI,
// and `serve` claims a temp data root, answers an authenticated `status`, and
// stops cleanly. With --record it writes the package evidence record the
// release manifest consumes before publishing. Exits non-zero on the first
// failure.
//
//   node scripts/smoke-package.mjs [--lane <lane>] [--out out/<lane>] [--artifact <file>]
//                                  [--skip-node-pty] [--record <file>] [--release-tag v<version>]
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, "..");
const pin = JSON.parse(fs.readFileSync(path.join(hostRoot, "runtime.pin.json"), "utf8"));
/** The product version: see package-host.mjs. */
const { version } = JSON.parse(fs.readFileSync(path.join(hostRoot, "..", "desktop", "package.json"), "utf8"));

/** Mirrors package-host.mjs: lane → platform/arch and archive suffix. */
const LANES = {
  "linux-x64": { platform: "linux", arch: "x64", archive: "tar.gz" },
  "mac-x64": { platform: "darwin", arch: "x64", archive: "zip" },
  "mac-arm64": { platform: "darwin", arch: "arm64", archive: "zip" },
  "win-x64": { platform: "win32", arch: "x64", archive: "zip" },
};
/** Mirrors package-host.mjs: bsdtar by path on Windows, where Git's GNU tar can shadow it (issue #470). */
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/** cli.ts EXIT codes the checks expect. */
const EXIT_OK = 0;
const EXIT_ABSENT = 3;
const STEP_TIMEOUT_MS = 30_000;
/** The boot claims, reaps, opens the credential protector (5 s worker cap), then binds; generous on a cold runner. */
const SERVE_READY_TIMEOUT_MS = 60_000;
const LOG_TAIL_BYTES = 64 * 1024;

function currentLane() {
  const key = `${process.platform}/${process.arch}`;
  const found = Object.entries(LANES).find(([, l]) => `${l.platform}/${l.arch}` === key);
  if (found === undefined) throw new Error(`no host lane for ${key}`);
  return found[0];
}

function parseArgs(argv) {
  const out = { lane: null, out: null, artifact: null, skipNodePty: false, record: null, releaseTag: `v${version}` };
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
    else if (arg === "--record") out.record = path.resolve(next());
    else if (arg.startsWith("--record=")) out.record = path.resolve(arg.slice("--record=".length));
    else if (arg === "--release-tag") out.releaseTag = next();
    else if (arg.startsWith("--release-tag=")) out.releaseTag = arg.slice("--release-tag=".length);
    else if (arg === "--skip-node-pty") out.skipNodePty = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  out.lane ??= currentLane();
  if (!(out.lane in LANES)) throw new Error(`unknown lane ${out.lane}; one of ${Object.keys(LANES).join(", ")}`);
  const lane = LANES[out.lane];
  if (lane.platform !== process.platform || lane.arch !== process.arch) {
    throw new Error(`lane ${out.lane} runs only on ${lane.platform}/${lane.arch} (this is ${process.platform}/${process.arch})`);
  }
  out.out ??= path.join(hostRoot, "out", out.lane);
  out.artifact ??= path.join(out.out, `omp-ui-host-${version}-${out.lane}.${lane.archive}`);
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

function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`stdout is not JSON: ${describe(result)}`);
  }
}

function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let read = fs.readSync(fd, chunk, 0, chunk.length, null);
    while (read > 0) {
      hash.update(chunk.subarray(0, read));
      read = fs.readSync(fd, chunk, 0, chunk.length, null);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Boots `serve` against an empty temp root, waits for host.json, probes
 * `status --json` (authenticated through the record's control credential),
 * then `stop`s it and waits for a clean exit. Returns what the live host
 * reported plus the step exit codes.
 */
async function serveAndProbe(bin, dataRoot, steps, log) {
  const env = { ...process.env, OMP_UI_DATA_DIR: dataRoot };
  const startedAtMs = Date.now();
  const child = spawn(bin, ["serve"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-LOG_TAIL_BYTES);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: null, signal: null, error: err }));
  });
  let exit = null;
  exited.then((result) => {
    exit = result;
  });

  const finish = (expected) => {
    steps.push({ name: "serve", exitCode: exit?.code ?? -1, expectedExitCode: expected, startedAtMs, endedAtMs: Date.now() });
    log(output);
  };

  try {
    const record = path.join(dataRoot, "host.json");
    const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
    while (!fs.existsSync(record)) {
      if (exit !== null) {
        throw new Error(`serve exited before writing host.json: ${exit.error?.message ?? `code ${exit.code} signal ${exit.signal}`}\n${output}`);
      }
      if (Date.now() > deadline) throw new Error(`serve wrote no host.json within ${SERVE_READY_TIMEOUT_MS} ms\n${output}`);
      await sleep(200);
    }

    const statusStarted = Date.now();
    const status = exec(bin, ["status", "--json"], { OMP_UI_DATA_DIR: dataRoot });
    steps.push({ name: "status --json (running)", exitCode: status.status ?? -1, expectedExitCode: EXIT_OK, startedAtMs: statusStarted, endedAtMs: Date.now() });
    const report = parseJson(status);
    if (status.status !== EXIT_OK || report?.state !== "running") {
      throw new Error(`expected exit ${EXIT_OK} and state "running", got ${describe(status)}`);
    }
    if (report.versions?.host !== version) {
      throw new Error(`live host reports version ${report.versions?.host}, package is ${version}`);
    }

    const stopStarted = Date.now();
    // Shorter than STEP_TIMEOUT_MS so a host that ignores the request reports through the CLI, not ETIMEDOUT.
    const stop = exec(bin, ["stop", "--timeout", "20"], { OMP_UI_DATA_DIR: dataRoot });
    steps.push({ name: "stop", exitCode: stop.status ?? -1, expectedExitCode: EXIT_OK, startedAtMs: stopStarted, endedAtMs: Date.now() });
    if (stop.status !== EXIT_OK) throw new Error(`expected exit ${EXIT_OK} from stop, got ${describe(stop)}`);

    const stopDeadline = Date.now() + STEP_TIMEOUT_MS;
    while (exit === null) {
      if (Date.now() > stopDeadline) throw new Error(`serve still running ${STEP_TIMEOUT_MS} ms after stop\n${output}`);
      await sleep(100);
    }
    if (exit.code !== 0) throw new Error(`serve exited ${exit.code ?? `signal ${exit.signal}`} after stop\n${output}`);
    if (fs.existsSync(record)) throw new Error("clean stop left host.json behind");
    finish(EXIT_OK);
    return report;
  } catch (err) {
    if (exit === null) {
      child.kill("SIGKILL");
      await exited;
    }
    finish(EXIT_OK);
    throw err;
  }
}

/** Each check throws with the process output on failure so the log names what broke. */
const CHECKS = [
  {
    name: "--version prints the packaged version",
    run(bin) {
      const result = exec(bin, ["--version"], {});
      if (result.status !== 0 || result.stdout.trim() !== version) {
        throw new Error(`expected exit 0 and "${version}", got ${describe(result)}`);
      }
      return result.status;
    },
  },
  {
    name: "status --json against an empty data root reports absent",
    expectedExitCode: EXIT_ABSENT,
    run(bin, scratch) {
      const dataRoot = path.join(scratch, "data-absent");
      fs.mkdirSync(dataRoot);
      const result = exec(bin, ["status", "--json"], { OMP_UI_DATA_DIR: dataRoot });
      const status = parseJson(result);
      if (result.status !== EXIT_ABSENT || status?.state !== "absent") {
        throw new Error(`expected exit ${EXIT_ABSENT} and state "absent", got ${describe(result)}`);
      }
      return result.status;
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
      return result.status;
    },
  },
];

/** The one rendered supervisor definition the package ships, hashed as release evidence. */
function serviceEvidence(layout) {
  const dir = path.join(layout, "service");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (files.length !== 1) throw new Error(`expected exactly one service definition under ${dir}, found ${files.length}`);
  return { file: files[0], sha256: sha256File(path.join(dir, files[0])) };
}

/** The vendored browser's pin and hash from the shipped manifest; null when the package has none. */
function browserManifest(layout) {
  const file = path.join(layout, "resources", "plan-verifier", "browser.manifest.json");
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  return { pin: manifest.version, sha256: manifest.sha256 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lane = LANES[args.lane];
  if (!fs.existsSync(args.artifact)) {
    throw new Error(`${args.artifact} does not exist; run scripts/package-host.mjs first or pass --artifact`);
  }
  const startedAt = new Date();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-host-smoke-"));
  const steps = [];
  const skipped = [];
  let serveLog = "";
  try {
    const unpacked = path.join(scratch, "unpacked");
    fs.mkdirSync(unpacked);
    // tar reads both formats: GNU tar the tarball, bsdtar (macOS, Windows 10+) the zip too.
    const untar = spawnSync(TAR, ["-xf", args.artifact, "-C", unpacked], { stdio: "inherit" });
    if (untar.error) throw new Error(`${TAR}: ${untar.error.message}`);
    if (untar.status !== 0) throw new Error(`${TAR} -xf ${args.artifact} exited ${untar.status}`);

    const layout = path.join(unpacked, version);
    const bin = path.join(layout, "bin", process.platform === "win32" ? "omp-ui.exe" : "omp-ui");
    if (!fs.existsSync(bin)) throw new Error(`${args.artifact} has no ${version}/bin/${path.basename(bin)}`);
    process.stdout.write(`unpacked ${path.basename(args.artifact)} → ${unpacked}\n`);

    let failed = 0;
    for (const check of CHECKS) {
      if (check.skip?.(args)) {
        skipped.push(check.name);
        process.stdout.write(`skip  ${check.name} (--skip-node-pty)\n`);
        continue;
      }
      const startedAtMs = Date.now();
      const expectedExitCode = check.expectedExitCode ?? EXIT_OK;
      try {
        const exitCode = check.run(bin, scratch);
        steps.push({ name: check.name, exitCode, expectedExitCode, startedAtMs, endedAtMs: Date.now() });
        process.stdout.write(`ok    ${check.name}\n`);
      } catch (err) {
        failed += 1;
        steps.push({ name: check.name, exitCode: -1, expectedExitCode, startedAtMs, endedAtMs: Date.now() });
        process.stdout.write(`FAIL  ${check.name}\n      ${(err instanceof Error ? err.message : String(err)).replace(/\n/g, "\n      ")}\n`);
      }
    }

    let live = null;
    const dataRoot = path.join(scratch, "data-serve");
    fs.mkdirSync(dataRoot);
    try {
      live = await serveAndProbe(bin, dataRoot, steps, (text) => {
        serveLog = text;
      });
      process.stdout.write("ok    serve claims an empty data root, answers status, and stops cleanly\n");
    } catch (err) {
      failed += 1;
      process.stdout.write(`FAIL  serve claims an empty data root, answers status, and stops cleanly\n      ${(err instanceof Error ? err.message : String(err)).replace(/\n/g, "\n      ")}\n`);
    }
    if (failed > 0) throw new Error(`${failed} of ${CHECKS.length + 1} smoke checks failed`);

    if (args.record !== null) {
      const browser = browserManifest(layout);
      const record = {
        schemaVersion: 1,
        kind: "host-package",
        releaseTag: args.releaseTag,
        platform: args.lane.slice(0, args.lane.indexOf("-")),
        arch: lane.arch,
        lane: args.lane,
        // Every check above ran the unpacked archive, never the source tree.
        source: "packaged",
        artifact: {
          name: path.basename(args.artifact),
          size: fs.statSync(args.artifact).size,
          sha256: sha256File(args.artifact),
        },
        versions: {
          host: live.versions.host,
          desktop: version,
          // The package bundles no OMP; the host installs managed OMP at runtime.
          omp: null,
          protocol: live.versions.protocol,
          protocolRange: live.versions.range,
          node: pin.node,
          abi: pin.abi,
        },
        service: serviceEvidence(layout),
        credentials: {
          backend: live.credentialBackend,
          outcome: live.credentialBackend === "unavailable" ? "degraded" : "available",
        },
        verifier: {
          state: live.verifier.state,
          reason: live.verifier.reason,
          pin: browser?.pin ?? live.verifier.pin ?? null,
          sha256: browser?.sha256 ?? live.verifier.sha256 ?? null,
        },
        supervisor: live.supervisor ?? null,
        runner: { os: process.platform, release: os.release(), node: process.version },
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        skipped,
        steps,
        logs: { dir: path.dirname(args.record), serve: `${path.basename(args.record)}.serve.log` },
      };
      fs.mkdirSync(path.dirname(args.record), { recursive: true });
      fs.writeFileSync(`${args.record}.serve.log`, serveLog);
      fs.writeFileSync(args.record, `${JSON.stringify(record, null, 2)}\n`);
      process.stdout.write(`record ${args.record}\n`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
