#!/usr/bin/env node
// Packages the persistent host as a Node single-executable application (issue
// #442 §10.1): the pinned Node runtime with the CLI bundle injected, node-pty
// built for that runtime's ABI, the verifier payload, the browser client's web
// bundle, and rendered supervisor definitions, laid out as
// out/<lane>/seed/<version>/{bin,lib,resources,service} and archived beside a
// `latest-host-<platform>.yml` feed for this lane.
//
//   node scripts/package-host.mjs [--lane linux-x64|mac-x64|mac-arm64|win-x64]
//                                 [--out out/<lane>] [--skip-node-pty] [--allow-unsigned]
//                                 [--allow-missing-verifier]
//
// The lane defaults to the running platform and must match it: a SEA blob
// carries a V8 code cache for the exact binary that generated it, so the
// downloaded Node builds its own blob. `out/<lane>/seed` is what
// electron-builder embeds as the desktop client's cold-start seed
// (`resources/host/<version>/`), so the layout root is the version directory.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hostFeedName, renderHostFeed, sha512Base64 } from "../../../scripts/host-feed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, "..");
const desktopRoot = path.resolve(hostRoot, "..", "desktop");
const pin = JSON.parse(fs.readFileSync(path.join(hostRoot, "runtime.pin.json"), "utf8"));
/**
 * The product version: the release tag is stamped onto packages/desktop only,
 * and the host and the desktop client that embeds it must agree on it (the
 * desktop names its seed directory by this version).
 */
const { version } = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const hostRequire = createRequire(path.join(hostRoot, "package.json"));

const NODE_DIST = "https://nodejs.org/dist";
const RELEASE_KEYS = path.join(here, "node-release-keys.asc");
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** Lane → Node's platform/arch, where the binary sits in the tarball, and the archive format we ship. */
const LANES = {
  "linux-x64": { platform: "linux", arch: "x64", nodeBinary: "bin/node", archive: "tar.gz" },
  "mac-x64": { platform: "darwin", arch: "x64", nodeBinary: "bin/node", archive: "zip" },
  "mac-arm64": { platform: "darwin", arch: "arm64", nodeBinary: "bin/node", archive: "zip" },
  "win-x64": { platform: "win32", arch: "x64", nodeBinary: "node.exe", archive: "zip" },
};

/**
 * The archiver. macOS and Windows 10+ ship bsdtar, which reads and writes zip;
 * on Windows it must be named by path because Git for Windows puts GNU tar
 * ahead of System32 on the release runner's PATH (issue #470), and GNU tar
 * neither reads a zip nor writes one — `-a -cf x.zip` silently emits a tar.
 */
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

/**
 * Not bundled: native addons and the modules that load them. The bundle's
 * banner resolves each from `<install>/lib/<name>` at runtime; marking them
 * side-effect free lets esbuild drop the ones the CLI never reaches (core's
 * pty module imports node-pty at top level) instead of requiring them on boot.
 */
const EXTERNALS = [
  /^node-pty$/,
  /^puppeteer-core$/,
  /^@napi-rs\/keyring$/,
  /^@primno\/dpapi$/,
  /^\.\/linux-secret-service\//,
  /\.node$/,
];

const SEA_REQUIRE_BANNER = `// The single-executable's require() reaches builtins only; the packager lays
// every external out beside the binary under lib/<name>.
const __sea = require("node:sea");
if (__sea.isSea()) {
  const __module = require("node:module");
  const __path = require("node:path");
  const __builtin = require;
  const __disk = __module.createRequire(process.execPath);
  const __lib = __path.join(__path.dirname(process.execPath), "..", "lib");
  require = (id) => (__module.isBuiltin(id) ? __builtin(id) : __disk(__path.join(__lib, id)));
}
`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function warn(message) {
  process.stderr.write(`warning: ${message}\n`);
}

function currentLane() {
  const key = `${process.platform}/${process.arch}`;
  const found = Object.entries(LANES).find(([, l]) => `${l.platform}/${l.arch}` === key);
  if (found === undefined) throw new Error(`no host lane for ${key}`);
  return found[0];
}

function parseArgs(argv) {
  const out = { lane: null, out: null, skipNodePty: false, allowUnsigned: false, allowMissingVerifier: false };
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
    else if (arg === "--skip-node-pty") out.skipNodePty = true;
    else if (arg === "--allow-unsigned") out.allowUnsigned = true;
    else if (arg === "--allow-missing-verifier") out.allowMissingVerifier = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  out.lane ??= currentLane();
  if (!(out.lane in LANES)) throw new Error(`unknown lane ${out.lane}; one of ${Object.keys(LANES).join(", ")}`);
  const lane = LANES[out.lane];
  if (lane.platform !== process.platform || lane.arch !== process.arch) {
    throw new Error(
      `lane ${out.lane} packages only on ${lane.platform}/${lane.arch} (this is ${process.platform}/${process.arch}): the SEA blob is built by the target runtime`,
    );
  }
  out.out ??= path.join(hostRoot, "out", out.lane);
  return out;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${result.status}`);
}

function capture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  return result;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`GET ${url} → ${res.status}`);
  const fd = fs.openSync(file, "w");
  try {
    for await (const chunk of res.body) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
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

/** `<sha256>  <file>` per line, as nodejs.org publishes it. */
function expectedSha(shasums, file) {
  for (const line of fs.readFileSync(shasums, "utf8").split("\n")) {
    const match = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (match && match[2] === file) return match[1];
  }
  throw new Error(`${file} is not listed in SHASUMS256.txt`);
}

function gpgAvailable() {
  const result = spawnSync("gpg", ["--version"], { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

/** Imports the pinned Node release keys into a throwaway keyring and checks the SHASUMS signature against them. */
function verifySignature(shasums, signature) {
  if (!fs.existsSync(RELEASE_KEYS)) {
    throw new Error(`${RELEASE_KEYS} is missing: it holds the Node.js release-signing keys the download is checked against`);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-node-keys-"));
  try {
    fs.chmodSync(home, 0o700);
    fs.copyFileSync(RELEASE_KEYS, path.join(home, "keys.asc"));
    fs.copyFileSync(shasums, path.join(home, "SHASUMS256.txt"));
    fs.copyFileSync(signature, path.join(home, "SHASUMS256.txt.sig"));
    const base = ["--batch", "--quiet", "--homedir", "."];
    const imported = capture("gpg", [...base, "--import", "keys.asc"], { cwd: home });
    if (imported.status !== 0) throw new Error(`gpg --import failed:\n${imported.stderr}`);
    const verified = capture("gpg", [...base, "--verify", "SHASUMS256.txt.sig", "SHASUMS256.txt"], { cwd: home });
    if (verified.status !== 0) {
      throw new Error(`SHASUMS256.txt signature did not verify against the Node.js release keys:\n${verified.stderr}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Downloads (or reuses) the pinned Node archive, checks it against the signed SHASUMS, and extracts the binary. */
async function fetchNode(laneName, allowUnsigned) {
  const lane = LANES[laneName];
  const version = pin.node;
  const archive = pin.lanes[laneName];
  if (typeof archive !== "string") throw new Error(`runtime.pin.json names no archive for lane ${laneName}`);
  const cache = path.join(hostRoot, ".cache", "node", `v${version}`);
  fs.mkdirSync(cache, { recursive: true });
  const files = {
    archive: path.join(cache, archive),
    shasums: path.join(cache, "SHASUMS256.txt"),
    signature: path.join(cache, "SHASUMS256.txt.sig"),
  };
  const remote = { archive, shasums: "SHASUMS256.txt", signature: "SHASUMS256.txt.sig" };

  for (const [key, name] of Object.entries(remote)) {
    if (fs.existsSync(files[key])) continue;
    const url = `${NODE_DIST}/v${version}/${name}`;
    log(`fetching ${url}`);
    await download(url, files[key]);
  }

  if (gpgAvailable()) {
    verifySignature(files.shasums, files.signature);
    log("SHASUMS256.txt signature verified against the Node.js release keys");
  } else if (allowUnsigned) {
    warn("gpg is not on PATH; skipping the SHASUMS256.txt signature check because --allow-unsigned was passed");
  } else {
    throw new Error("gpg is not on PATH: install gnupg to verify the Node download, or pass --allow-unsigned");
  }

  const expected = expectedSha(files.shasums, archive);
  let actual = sha256File(files.archive);
  if (actual !== expected) {
    warn(`${archive} in the cache hashes to ${actual}, expected ${expected}; re-downloading`);
    await download(`${NODE_DIST}/v${version}/${archive}`, files.archive);
    actual = sha256File(files.archive);
    if (actual !== expected) throw new Error(`${archive} sha256 mismatch: got ${actual}, SHASUMS256.txt says ${expected}`);
  }
  log(`${archive} sha256 ${actual} matches SHASUMS256.txt`);

  const prefix = archive.replace(/\.(tar\.xz|tar\.gz|zip)$/, "");
  const member = `${prefix}/${lane.nodeBinary}`;
  const binary = path.join(cache, ...member.split("/"));
  if (!fs.existsSync(binary)) {
    // Run inside the cache so tar receives local relative paths; a Windows
    // drive colon is otherwise parsed as a remote archive.
    run(TAR, ["-xf", archive, member], { cwd: cache });
    if (!fs.existsSync(binary)) throw new Error(`${member} was not extracted from ${archive}`);
  }
  const reported = capture(binary, ["--version"]).stdout.trim();
  if (reported !== `v${version}`) throw new Error(`downloaded node reports ${reported}, pin says v${version}`);
  const abi = capture(binary, ["-p", "process.versions.modules"]).stdout.trim();
  if (abi !== String(pin.abi)) throw new Error(`downloaded node has ABI ${abi}, runtime.pin.json says ${pin.abi}`);
  return binary;
}

/**
 * Node builtins get the same treatment: an import only an unreached module
 * uses (core's memory store and `node:sqlite`, whose load prints an
 * experimental warning) should not run on every CLI invocation.
 */
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

async function bundleCli(esbuild) {
  const outfile = path.join(hostRoot, "dist", "cli.cjs");
  await esbuild.build({
    entryPoints: [path.join(hostRoot, "src", "cli-main.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    define: { __HOST_VERSION__: JSON.stringify(version) },
    banner: { js: SEA_REQUIRE_BANNER },
    plugins: [externalsPlugin()],
    legalComments: "none",
    logLevel: "warning",
  });
  log(`bundled src/cli-main.ts → ${path.relative(hostRoot, outfile)} (${fs.statSync(outfile).size} bytes)`);
  return outfile;
}

/** Copies the pinned Node, has it build the SEA blob from sea-config.json, and injects the blob into the copy. */
async function buildSea(nodeBinary, laneName, layout) {
  const lane = LANES[laneName];
  const bin = path.join(layout, "bin", lane.platform === "win32" ? "omp-ui.exe" : "omp-ui");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.copyFileSync(nodeBinary, bin);
  fs.chmodSync(bin, 0o755);
  if (lane.platform === "darwin") run("codesign", ["--remove-signature", bin]);

  const blob = path.join(hostRoot, "dist", "sea-prep.blob");
  fs.rmSync(blob, { force: true });
  run(nodeBinary, ["--experimental-sea-config", "sea-config.json"], { cwd: hostRoot });
  if (!fs.existsSync(blob)) throw new Error(`${blob} was not produced`);

  const { inject } = await import("postject");
  await inject(bin, "NODE_SEA_BLOB", fs.readFileSync(blob), {
    sentinelFuse: SEA_FUSE,
    ...(lane.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (lane.platform === "darwin") run("codesign", ["--sign", "-", bin]);
  log(`injected ${path.relative(hostRoot, blob)} into ${path.relative(hostRoot, bin)}`);
  return bin;
}

function copyTree(from, to, filter) {
  // Framework links must stay relative when the host seed moves into a desktop bundle.
  fs.cpSync(from, to, { recursive: true, filter, verbatimSymlinks: true });
}

/**
 * Rebuilds node-pty against the pinned Node in a scratch copy — never the tree
 * under node_modules, which electron-rebuild may have pointed at Electron's
 * ABI — ships `package.json`, `lib/`, and the native output, then proves the
 * shipped addon loads under the downloaded binary.
 */
function packageNodePty(nodeBinary, laneName, layout) {
  const lane = LANES[laneName];
  const source = path.dirname(hostRequire.resolve("node-pty/package.json"));
  const addonApi = path.dirname(hostRequire.resolve("node-addon-api/package.json"));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-node-pty-"));
  try {
    const copy = path.join(scratch, "node_modules", "node-pty");
    copyTree(source, copy, (src) => {
      const rel = path.relative(source, src);
      return !(rel === "build" || rel.startsWith(`build${path.sep}`) || rel === "node_modules" || rel.startsWith(`node_modules${path.sep}`));
    });
    // binding.gyp resolves node-addon-api from the package's own tree.
    copyTree(addonApi, path.join(scratch, "node_modules", "node-addon-api"));
    fs.writeFileSync(path.join(scratch, "package.json"), `${JSON.stringify({ name: "omp-ui-node-pty-rebuild", private: true }, null, 2)}\n`);

    log(`rebuilding node-pty for node v${pin.node} (ABI ${pin.abi}) in ${scratch}`);
    run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["rebuild", "node-pty", `--runtime=node`, `--target=${pin.node}`, `--arch=${lane.arch}`],
      { cwd: scratch, shell: process.platform === "win32" },
    );

    const dest = path.join(layout, "lib", "node-pty");
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(source, "package.json"), path.join(dest, "package.json"));
    copyTree(path.join(copy, "lib"), path.join(dest, "lib"), (src) => {
      return !src.endsWith(".test.js") && !src.endsWith(".js.map") && !src.endsWith(".d.ts");
    });
    // node-pty's install script keeps a bundled prebuild instead of running
    // node-gyp, and its postinstall then adds only build/Release/conpty/ on
    // Windows (issue #474): ship the prebuild first and let whatever landed in
    // build/Release — a real gyp build, or that ConPTY directory — overlay it.
    const release = path.join(dest, "build", "Release");
    const shipped = [];
    for (const dir of [path.join("prebuilds", `${lane.platform}-${lane.arch}`), path.join("build", "Release")]) {
      if (!fs.existsSync(path.join(copy, dir))) continue;
      copyTree(path.join(copy, dir), release, (src) => !src.endsWith(".pdb"));
      shipped.push(dir.split(path.sep).join("/"));
    }
    if (shipped.length === 0) throw new Error(`node-pty produced neither build/Release nor prebuilds/${lane.platform}-${lane.arch}`);
    const required =
      lane.platform === "win32"
        ? ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"]
        : lane.platform === "darwin"
          ? ["pty.node", "spawn-helper"]
          : ["pty.node"];
    for (const file of required) {
      if (!fs.existsSync(path.join(release, ...file.split("/")))) {
        throw new Error(`node-pty native output lacks ${file} (shipped from ${shipped.join(", ")})`);
      }
    }
    log(`node-pty native output from ${shipped.join(" + ")} → lib/node-pty/build/Release`);

    // Windows loads its addon on the first spawn, not at require time, so the
    // probe asks node-pty's own loader for it explicitly.
    const addon = lane.platform === "win32" ? "conpty" : "pty";
    const probe =
      "const dir = process.argv[1]; require(dir); " +
      `require(require('node:path').join(dir, 'lib', 'utils')).loadNativeModule(${JSON.stringify(addon)}); ` +
      "process.stdout.write('ok')";
    const loaded = capture(nodeBinary, ["-e", probe, dest]);
    if (loaded.status !== 0 || loaded.stdout !== "ok") {
      throw new Error(`shipped node-pty does not load under node v${pin.node}:\n${loaded.stderr}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The verifier browser is vendored, never fetched at runtime (issue #442 §7), so
 * a release package refuses to ship without it; `--allow-missing-verifier` is
 * for local packaging where the fetch was skipped on purpose.
 */
function packageResources(laneName, layout, allowMissingVerifier) {
  const browser = path.join(hostRoot, "resources", "plan-verifier", laneName);
  if (fs.existsSync(path.join(browser, "browser.manifest.json"))) {
    copyTree(browser, path.join(layout, "resources", "plan-verifier"));
    log(`verifier browser from resources/plan-verifier/${laneName} → resources/plan-verifier`);
  } else if (allowMissingVerifier) {
    warn(`no verifier browser at resources/plan-verifier/${laneName}; the package ships without one (--allow-missing-verifier)`);
  } else {
    throw new Error(`no verifier browser at resources/plan-verifier/${laneName}: run scripts/fetch-verifier-browser.mjs, or pass --allow-missing-verifier for a local package`);
  }
  const page = path.join(hostRoot, "dist", "verifier");
  if (fs.existsSync(path.join(page, "index.html"))) {
    copyTree(page, path.join(layout, "resources", "verifier-page"));
    log("verifier page from dist/verifier → resources/verifier-page");
  } else if (allowMissingVerifier) {
    warn("no verifier page at dist/verifier; the package ships without one (--allow-missing-verifier)");
  } else {
    throw new Error("no verifier page at dist/verifier: run `npm run build --workspace @omp-ui/host`");
  }
  // Browser clients of an installed host load the web bundle from
  // resources/web (cli-main's webRoot); without it the host serves transport only.
  const web = path.join(desktopRoot, "out", "web");
  if (fs.existsSync(path.join(web, "index.html"))) {
    copyTree(web, path.join(layout, "resources", "web"));
    log("browser client from ../desktop/out/web → resources/web");
  } else {
    warn("no browser client at ../desktop/out/web (run `npm run build --workspace @omp-ui/desktop`); the host serves the transport only");
  }
}

/**
 * The credential worker (`dek-worker-entry.cjs`) runs on a Worker thread from
 * a real file, so it and the native binding for the lane's platform ship
 * under `lib/` beside the binary: `lib/dek-worker-entry.cjs`, the in-repo
 * Secret Service addon at `lib/linux-secret-service/` (Linux), or the npm
 * binding at `lib/<name>` with its platform package under `lib/node_modules/`
 * (macOS Keychain, Windows DPAPI) where Node's resolver finds it.
 */
function packageCredentialWorker(laneName, layout) {
  const lane = LANES[laneName];
  const lib = path.join(layout, "lib");
  const credentials = path.join(hostRoot, "src", "credentials");
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(path.join(credentials, "dek-worker-entry.cjs"), path.join(lib, "dek-worker-entry.cjs"));
  if (lane.platform === "linux") {
    const addon = path.join(credentials, "linux-secret-service");
    const dest = path.join(lib, "linux-secret-service");
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(addon, "index.cjs"), path.join(dest, "index.cjs"));
    const built = path.join(addon, "build", "Release", "secret_service.node");
    if (fs.existsSync(built)) {
      copyTree(path.join(addon, "build", "Release"), path.join(dest, "build", "Release"));
      log("secret-service addon → lib/linux-secret-service/build/Release");
    } else {
      warn("secret-service addon not built (npm run build:secret-service); the package's Linux keyring is degraded");
    }
    return;
  }
  const binding = lane.platform === "darwin" ? "@napi-rs/keyring" : "@primno/dpapi";
  let bindingDir;
  try {
    bindingDir = path.dirname(hostRequire.resolve(`${binding}/package.json`));
  } catch {
    warn(`${binding} is not installed on this machine; the package's keyring binding is missing`);
    return;
  }
  copyTree(bindingDir, path.join(lib, binding));
  const manifest = JSON.parse(fs.readFileSync(path.join(bindingDir, "package.json"), "utf8"));
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
    let depDir;
    try {
      depDir = path.dirname(hostRequire.resolve(`${dep}/package.json`));
    } catch {
      continue; // another platform's binary; npm never installed it here
    }
    copyTree(depDir, path.join(lib, "node_modules", dep));
    log(`${dep} → lib/node_modules/${dep}`);
  }
  log(`${binding} → lib/${binding}`);
}

/**
 * Renders the lane's supervisor definition for the documented install paths
 * with a neutral home, through the same `selectSupervisor(...).render` the
 * CLI's `install` uses at install time. The bundle exists only to run TS.
 */
async function packageService(esbuild, laneName, layout) {
  const lane = LANES[laneName];
  const outfile = path.join(hostRoot, "dist", `render-service.${process.pid}.mjs`);
  const entry = `
    import * as path from "node:path";
    import { resolveDataRoot } from "@omp-ui/core";
    import { selectSupervisor } from "./supervisor";
    const HOMES = { linux: "/home/omp", darwin: "/Users/omp", win32: "C:\\\\Users\\\\omp" };
    export function renderService(platform) {
      const home = HOMES[platform];
      const p = platform === "win32" ? path.win32 : path.posix;
      const execPath =
        platform === "win32"
          ? p.join(home, "AppData", "Local", "omp-ui-host", "bin", "omp-ui.exe")
          : p.join(home, ".local", "bin", "omp-ui");
      const dataRoot = resolveDataRoot("installed", {}, platform, home);
      const supervisor = selectSupervisor({
        run: async () => ({ code: 0, stdout: "", stderr: "" }),
        home,
        platform,
      });
      const text = supervisor.render({ execPath, dataRoot, logDir: p.join(dataRoot, "logs") });
      // schtasks has no definition file, so the task name is not a path.
      const fileName = platform === "win32" ? "omp-ui-host.task.xml" : p.basename(supervisor.definitionPath);
      const bytes = platform === "win32" ? Buffer.from("\\ufeff" + text, "utf16le") : Buffer.from(text, "utf8");
      return { fileName, bytes };
    }
  `;
  try {
    await esbuild.build({
      stdin: { contents: entry, resolveDir: path.join(hostRoot, "src"), loader: "ts", sourcefile: "render-service.ts" },
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      plugins: [externalsPlugin()],
      legalComments: "none",
      logLevel: "warning",
    });
    const { renderService } = await import(pathToFileURL(outfile).href);
    const { fileName, bytes } = renderService(lane.platform);
    const dir = path.join(layout, "service");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), bytes);
    log(`rendered ${lane.platform} supervisor definition → service/${fileName}`);
  } finally {
    fs.rmSync(outfile, { force: true });
  }
}

/** `<out>/omp-ui-host-<version>-<lane>.<ext>` whose top-level entry is `<version>/`. */
function archive(laneName, out, seed) {
  const lane = LANES[laneName];
  const name = `omp-ui-host-${version}-${laneName}.${lane.archive}`;
  const file = path.join(out, name);
  fs.rmSync(file, { force: true });
  const input = path.relative(out, seed);
  if (lane.archive === "tar.gz") {
    run(TAR, ["-czf", name, "-C", input, version], { cwd: out });
  } else {
    // bsdtar picks the zip format from the suffix.
    run(TAR, ["-a", "-cf", name, "-C", input, version], { cwd: out });
    const magic = Buffer.alloc(2);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, magic, 0, 2, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (magic.toString("latin1") !== "PK") throw new Error(`${name} is not a zip: ${TAR} wrote ${magic.toString("hex")}, not PK`);
  }
  log(`archived ${path.relative(hostRoot, file)} (${fs.statSync(file).size} bytes)`);
  return file;
}

/**
 * This lane's `latest-host-<platform>.yml`. Linux and Windows publish it as
 * is; the two macOS lanes build on separate runners, so release-manifest
 * composes their one two-arch feed from the uploaded archives with the same
 * renderer (scripts/host-feed.mjs).
 */
async function writeFeed(laneName, out, archiveFile) {
  const lane = LANES[laneName];
  const platform = laneName.slice(0, laneName.indexOf("-"));
  const feed = path.join(out, hostFeedName(platform));
  const text = renderHostFeed({
    version,
    files: [
      {
        url: path.basename(archiveFile),
        arch: lane.arch,
        size: fs.statSync(archiveFile).size,
        sha512: await sha512Base64(archiveFile),
      },
    ],
  });
  fs.writeFileSync(feed, text);
  log(`feed ${path.relative(hostRoot, feed)}`);
  return feed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const esbuild = await import("esbuild");
  const nodeBinary = await fetchNode(args.lane, args.allowUnsigned);

  const seed = path.join(args.out, "seed");
  const layout = path.join(seed, version);
  fs.rmSync(seed, { recursive: true, force: true });
  fs.mkdirSync(layout, { recursive: true });

  await bundleCli(esbuild);
  await buildSea(nodeBinary, args.lane, layout);
  if (args.skipNodePty) warn("--skip-node-pty: the package ships without lib/node-pty");
  else packageNodePty(nodeBinary, args.lane, layout);
  packageResources(args.lane, layout, args.allowMissingVerifier);
  packageCredentialWorker(args.lane, layout);
  await packageService(esbuild, args.lane, layout);
  const file = archive(args.lane, args.out, seed);
  await writeFeed(args.lane, args.out, file);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
