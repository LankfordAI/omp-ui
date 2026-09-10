#!/usr/bin/env node
// Fetches the pinned Chrome for Testing build the plan verifier drives (issue
// #442 §8.3) into packages/host/resources/plan-verifier/<os>-<arch>/ and
// writes browser.manifest.json beside it. Build-time only: the app never
// downloads at runtime and never runs a system browser.
//
//   node scripts/fetch-verifier-browser.mjs [--platform linux64|mac-x64|mac-arm64|win64]
//   node scripts/fetch-verifier-browser.mjs --pin      # re-pin to current Stable, record zip hashes
//
// The pin (verifier/browser.pin.json) names one Stable version and the
// SHA-256 of each platform's FULL `chrome` zip — never chrome-headless-shell,
// whose layout engine is not the one users see.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(here, "..");
const pinFile = path.join(hostRoot, "verifier", "browser.pin.json");
const resourcesRoot = path.join(hostRoot, "resources", "plan-verifier");
const LKG_URL =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

/** CfT platform → where electron-builder's `${os}-${arch}` finds it, Node's platform/arch, binary path in the zip. */
const PLATFORMS = {
  linux64: {
    dir: "linux-x64",
    platform: "linux",
    arch: "x64",
    executable: "chrome-linux64/chrome",
  },
  "mac-x64": {
    dir: "mac-x64",
    platform: "darwin",
    arch: "x64",
    executable:
      "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  },
  "mac-arm64": {
    dir: "mac-arm64",
    platform: "darwin",
    arch: "arm64",
    executable:
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  },
  win64: {
    dir: "win-x64",
    platform: "win32",
    arch: "x64",
    executable: "chrome-win64/chrome.exe",
  },
};

function currentPlatform() {
  const key = `${process.platform}/${process.arch}`;
  const found = Object.entries(PLATFORMS).find(([, p]) => `${p.platform}/${p.arch}` === key);
  if (found === undefined) throw new Error(`no Chrome for Testing build for ${key}`);
  return found[0];
}

function parseArgs(argv) {
  const out = { pin: false, platform: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pin") out.pin = true;
    else if (arg === "--platform") {
      out.platform = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith("--platform=")) out.platform = arg.slice("--platform=".length);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (out.platform !== null && !(out.platform in PLATFORMS)) {
    throw new Error(`unknown platform ${out.platform}; one of ${Object.keys(PLATFORMS).join(", ")}`);
  }
  return out;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok || res.body === null) throw new Error(`GET ${url} → ${res.status}`);
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "w");
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
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

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  // `unzip` keeps mode bits and the symlinks inside the mac framework bundle;
  // Expand-Archive is the Windows equivalent (no symlinks in that zip).
  const result =
    process.platform === "win32"
      ? spawnSync(
          "powershell",
          ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`],
          { stdio: "inherit" },
        )
      : spawnSync("unzip", ["-q", "-o", zip, "-d", dest], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`unzip exited ${result.status}`);
}

async function pin() {
  const res = await fetch(LKG_URL);
  if (!res.ok) throw new Error(`GET ${LKG_URL} → ${res.status}`);
  const lkg = await res.json();
  const stable = lkg.channels?.Stable;
  if (typeof stable?.version !== "string") throw new Error("no Stable channel in the LKG feed");
  const urls = new Map(stable.downloads.chrome.map((d) => [d.platform, d.url]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cft-"));
  const platforms = {};
  try {
    for (const key of Object.keys(PLATFORMS)) {
      const url = urls.get(key);
      if (url === undefined) throw new Error(`Stable ${stable.version} has no chrome zip for ${key}`);
      const zip = path.join(tmp, `${key}.zip`);
      process.stderr.write(`hashing ${url}\n`);
      const sha256 = await download(url, zip);
      fs.rmSync(zip, { force: true });
      platforms[key] = { url, sha256 };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const pinned = { version: stable.version, platforms };
  fs.writeFileSync(pinFile, `${JSON.stringify(pinned, null, 2)}\n`);
  process.stderr.write(`pinned Chrome for Testing ${stable.version} → ${pinFile}\n`);
}

async function fetchPinned(key) {
  const pinned = JSON.parse(fs.readFileSync(pinFile, "utf8"));
  const entry = pinned.platforms?.[key];
  if (entry === undefined) throw new Error(`browser.pin.json has no entry for ${key}`);
  const spec = PLATFORMS[key];
  const dest = path.join(resourcesRoot, spec.dir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cft-"));
  try {
    const zip = path.join(tmp, `${key}.zip`);
    process.stderr.write(`downloading ${entry.url}\n`);
    const sha256 = await download(entry.url, zip);
    if (entry.sha256 !== null && sha256 !== entry.sha256) {
      throw new Error(`zip hash mismatch for ${key}: pinned ${entry.sha256}, downloaded ${sha256}`);
    }
    if (entry.sha256 === null) {
      process.stderr.write(`warning: browser.pin.json records no hash for ${key}; downloaded ${sha256}\n`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    unzip(zip, dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const executable = path.join(dest, spec.executable);
  if (!fs.statSync(executable).isFile()) throw new Error(`no browser binary at ${executable}`);
  const manifest = {
    version: pinned.version,
    platform: spec.platform,
    arch: spec.arch,
    executable: spec.executable,
    sha256: sha256File(executable),
  };
  fs.writeFileSync(path.join(dest, "browser.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(
    `unpacked Chrome for Testing ${pinned.version} (${key}) → ${dest}\n` +
      `dev runs: OMP_UI_VERIFIER_BROWSER=${dest}\n`,
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.pin) await pin();
else await fetchPinned(args.platform ?? currentPlatform());
