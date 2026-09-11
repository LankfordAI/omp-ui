import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { HOST_ARCHIVE_EXT } from "./host-feed.mjs";

// Kinds every requested architecture must ship (issue #442 §10.1): the desktop
// distributables plus the persistent host archive for that arch.
const PLATFORM_KINDS = {
  linux: ["appimage", "host"],
  mac: ["dmg", "zip", "host"],
  win: ["nsis", "host"],
};

/** Per-platform kinds: one feed lists every arch of the platform. */
const PLATFORM_FEEDS = ["host-feed"];

const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_DATE_RE = /^\d{4}-\d\d-\d\dT[^']+$/;

function compareNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linuxArchNames(arch) {
  switch (arch) {
    case "x64":
      return ["x64", "amd64", "x86_64"];
    case "arm64":
      return ["arm64", "aarch64"];
    case "armv7l":
      return ["armv7l", "armhf"];
    default:
      return [arch];
  }
}

function classify(file, target) {
  const version = escapeRegExp(target.version);
  const platform = escapeRegExp(target.platform);

  if (file.name === `latest-host-${target.platform}.yml`) {
    return { arch: null, kind: "host-feed" };
  }

  for (const arch of target.arches) {
    const escapedArch = escapeRegExp(arch);
    if (
      new RegExp(
        `^omp-ui-host-${version}-${platform}-${escapedArch}\\.${escapeRegExp(HOST_ARCHIVE_EXT[target.platform])}$`,
      ).test(file.name)
    ) {
      return { arch, kind: "host" };
    }

    if (target.platform === "mac") {
      const match = file.name.match(
        new RegExp(`^omp-ui-${version}-mac-preview-${escapedArch}\\.(dmg|zip)$`),
      );
      if (match) return { arch, kind: match[1] };
    }

    if (
      target.platform === "win" &&
      new RegExp(
        `^omp-ui-${version}-windows-preview-${escapedArch}-setup\\.exe$`,
      ).test(file.name)
    ) {
      return { arch, kind: "nsis" };
    }

    if (target.platform === "linux") {
      const aliases = linuxArchNames(arch).map(escapeRegExp).join("|");
      if (
        new RegExp(
          `^omp-ui[-_]${version}(?:[-_.](?:${aliases}))?\\.AppImage$`,
          "i",
        ).test(file.name)
      ) {
        if (
          target.arches.length > 1 &&
          !new RegExp(`(?:^|[-_.])(?:${aliases})(?:[-_.]|$)`, "i").test(file.name)
        ) {
          continue;
        }
        return { arch, kind: "appimage" };
      }
      if (
        new RegExp(`^omp-ui[-_]${version}[-_](?:${aliases})\\.deb$`, "i").test(
          file.name,
        )
      ) {
        return { arch, kind: "deb" };
      }
    }
  }

  return null;
}

function assertTarget(target) {
  if (!Object.hasOwn(PLATFORM_KINDS, target?.platform)) {
    throw new Error(`Unsupported platform: ${target?.platform ?? ""}`);
  }
  if (typeof target.version !== "string" || target.version.length === 0) {
    throw new Error("Target version is required");
  }
  if (!Array.isArray(target.arches) || target.arches.length === 0) {
    throw new Error("Target arches are required");
  }
  if (target.arches.some((arch) => typeof arch !== "string" || arch.length === 0)) {
    throw new Error("Target arches must be non-empty strings");
  }
  if (new Set(target.arches).size !== target.arches.length) {
    throw new Error("Target arches contain duplicates");
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/** Throws with `where` in the message on the first field that fails its predicate. */
function requireFields(where, record, checks) {
  for (const [field, predicate] of Object.entries(checks)) {
    const value = field.split(".").reduce((node, key) => (isRecord(node) ? node[key] : undefined), record);
    if (!predicate(value)) throw new Error(`${where}: invalid ${field}: ${JSON.stringify(value)}`);
  }
}

/**
 * One `host-package` record per requested arch. Every field the spec names
 * must be present and coherent with the release: the tag, the exact archive
 * (name and SHA-256), host/desktop versions equal to the release version,
 * a rendered service definition, a credential outcome, a ready verifier with
 * its Chrome pin/hash, timing, and exit codes. Skips and source-tree runs
 * are refused: evidence comes from the unpacked archive or not at all.
 */
function validateHostPackageRecord(record, target, hostArtifacts, where) {
  requireFields(where, record, {
    schemaVersion: (v) => v === 1,
    kind: (v) => v === "host-package",
    releaseTag: (v) => v === `v${target.version}`,
    platform: (v) => v === target.platform,
    arch: nonEmptyString,
    source: (v) => v === "packaged" || v === "source-tree",
    "artifact.name": nonEmptyString,
    "artifact.size": (v) => Number.isSafeInteger(v) && v > 0,
    "artifact.sha256": (v) => typeof v === "string" && SHA256_RE.test(v),
    "versions.host": (v) => v === target.version,
    "versions.desktop": (v) => v === target.version,
    "versions.omp": (v) => v === null || nonEmptyString(v),
    "versions.protocol": (v) => Number.isSafeInteger(v) && v > 0,
    "versions.protocolRange.min": (v) => Number.isSafeInteger(v) && v > 0,
    "versions.protocolRange.max": (v) => Number.isSafeInteger(v) && v > 0,
    "versions.node": nonEmptyString,
    "versions.abi": (v) => Number.isSafeInteger(v) && v > 0,
    "service.file": nonEmptyString,
    "service.sha256": (v) => typeof v === "string" && SHA256_RE.test(v),
    "credentials.backend": nonEmptyString,
    "credentials.outcome": (v) => v === "available" || v === "degraded",
    "verifier.state": (v) => v === "ready" || v === "degraded",
    "verifier.pin": (v) => v === null || nonEmptyString(v),
    "verifier.sha256": (v) => v === null || (typeof v === "string" && SHA256_RE.test(v)),
    startedAt: (v) => typeof v === "string" && ISO_DATE_RE.test(v),
    finishedAt: (v) => typeof v === "string" && ISO_DATE_RE.test(v),
    skipped: (v) => Array.isArray(v) && v.every(nonEmptyString),
    steps: (v) => Array.isArray(v) && v.length > 0,
    "logs.dir": nonEmptyString,
  });
  for (const [index, step] of record.steps.entries()) {
    requireFields(`${where} steps[${index}]`, step, {
      name: nonEmptyString,
      exitCode: (v) => Number.isSafeInteger(v),
      expectedExitCode: (v) => Number.isSafeInteger(v),
      startedAtMs: (v) => Number.isSafeInteger(v) && v > 0,
      endedAtMs: (v) => Number.isSafeInteger(v) && v > 0,
    });
    if (step.exitCode !== step.expectedExitCode) {
      throw new Error(`${where}: step ${step.name} exited ${step.exitCode}, expected ${step.expectedExitCode}`);
    }
  }
  if (record.source !== "packaged") {
    throw new Error(`${where}: evidence from a ${record.source} run is not release evidence`);
  }
  if (record.skipped.length > 0) {
    throw new Error(`${where}: skipped ${record.skipped.join(", ")}`);
  }
  if (!target.arches.includes(record.arch)) {
    throw new Error(`${where}: unexpected ${target.platform} arch ${record.arch}`);
  }
  if (record.verifier.state !== "ready" || record.verifier.pin === null || record.verifier.sha256 === null) {
    throw new Error(`${where}: verifier ${record.verifier.state}: ${record.verifier.reason ?? "no pin"}`);
  }
  const artifact = hostArtifacts.get(record.arch);
  if (record.artifact.name !== artifact.name) {
    throw new Error(`${where}: names ${record.artifact.name}, the release ships ${artifact.name}`);
  }
  if (record.artifact.size !== artifact.size) {
    throw new Error(`${where}: ${artifact.name} is ${record.artifact.size} bytes in the record, ${artifact.size} in the release`);
  }
  if (artifact.sha256 !== undefined && artifact.sha256 !== record.artifact.sha256) {
    throw new Error(`${where}: ${artifact.name} SHA-256 ${record.artifact.sha256} does not match the release asset ${artifact.sha256}`);
  }
}

function validateRecords(records, target, artifacts) {
  const hostArtifacts = new Map(
    artifacts.filter(({ kind }) => kind === "host").map((artifact) => [artifact.arch, artifact]),
  );
  const seenPackages = new Map();
  for (const { name, record } of records) {
    const where = `Record ${name}`;
    if (!isRecord(record)) throw new Error(`${where}: not an object`);
    if (record.kind === "host-package") {
      if (record.platform !== target.platform) continue;
      validateHostPackageRecord(record, target, hostArtifacts, where);
      const previous = seenPackages.get(record.arch);
      if (previous) throw new Error(`Duplicate ${target.platform} host-package record for ${record.arch}: ${previous}, ${name}`);
      seenPackages.set(record.arch, name);
    } else {
      throw new Error(`${where}: unknown record kind ${JSON.stringify(record.kind)}`);
    }
  }
  const missing = target.arches.filter((arch) => !seenPackages.has(arch)).map((arch) => `${arch} host-package`);
  if (missing.length > 0) {
    throw new Error(`Missing ${target.platform} records: ${missing.join(", ")}`);
  }
  return {
    packages: target.arches.map((arch) => seenPackages.get(arch)),
    gates: [],
  };
}

/**
 * `files`: `{ name, size, sha256? }` per release asset. `records`: `{ name,
 * record }` per evidence file. Returns the classified artifacts, the sorted
 * checksum inputs, the macOS desktop feed plan, and which records vouch for
 * the release.
 */
export function planReleaseManifest(files, target, records = []) {
  assertTarget(target);

  const duplicateNames = files
    .map(({ name }) => name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  if (duplicateNames.length > 0) {
    throw new Error(`Duplicate artifact: ${duplicateNames.sort()[0]}`);
  }

  const artifacts = [];
  const seen = new Map();
  for (const file of files) {
    if (
      typeof file?.name !== "string" ||
      file.name.length === 0 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    ) {
      throw new Error("Files must have a name and a non-negative integer size");
    }
    const classification = classify(file, target);
    if (!classification) continue;

    const key = `${classification.arch}:${classification.kind}`;
    const previous = seen.get(key);
    if (previous) {
      throw new Error(
        `Duplicate ${target.platform} ${classification.kind} artifact for ${classification.arch}: ${previous}, ${file.name}`,
      );
    }
    seen.set(key, file.name);
    artifacts.push({
      name: file.name,
      size: file.size,
      ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
      platform: target.platform,
      arch: classification.arch,
      kind: classification.kind,
    });
  }

  const missing = [];
  for (const arch of target.arches) {
    for (const kind of PLATFORM_KINDS[target.platform]) {
      if (!seen.has(`${arch}:${kind}`)) missing.push(`${arch} ${kind}`);
    }
  }
  for (const kind of PLATFORM_FEEDS) {
    if (!seen.has(`null:${kind}`)) missing.push(kind);
  }
  if (missing.length > 0) {
    throw new Error(`Missing ${target.platform} artifacts: ${missing.join(", ")}`);
  }

  const evidence = validateRecords(records, target, artifacts);

  artifacts.sort(compareNames);
  // Feeds are metadata about the archives, not checksummed distributables.
  const checksumInputs = artifacts.filter(({ kind }) => kind !== "host-feed").map(({ name }) => name);
  let latestMac = null;
  if (target.platform === "mac") {
    const byArchAndKind = new Map(
      artifacts.map((artifact) => [`${artifact.arch}:${artifact.kind}`, artifact]),
    );
    const macFiles = target.arches.flatMap((arch) => [
      byArchAndKind.get(`${arch}:dmg`),
      byArchAndKind.get(`${arch}:zip`),
    ]);
    latestMac = {
      version: target.version,
      files: macFiles.map(({ name, size }) => ({ url: name, size })),
      path: macFiles[0].name,
    };
  }

  return { artifacts, checksumInputs, latestMac, evidence };
}

function parseArguments(argv) {
  const values = {};
  const allowed = new Set(["dir", "platform", "version", "arches", "out-dir", "records"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Expected a value after ${flag ?? "CLI arguments"}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option: ${flag}`);
    if (values[name] !== undefined) throw new Error(`Duplicate option: ${flag}`);
    values[name] = value;
  }

  for (const name of allowed) {
    if (!values[name]) throw new Error(`Missing required option: --${name}`);
  }
  return {
    dir: values.dir,
    outDir: values["out-dir"],
    recordsDir: values.records,
    target: {
      platform: values.platform,
      version: values.version,
      arches: values.arches.split(",").map((arch) => arch.trim()),
    },
  };
}

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  await new Promise((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest(encoding);
}

async function renderLatestMac(plan, dir) {
  const files = [];
  for (const file of plan.latestMac.files) {
    files.push({ ...file, sha512: await digest(path.join(dir, file.url), "sha512", "base64") });
  }
  const primary = files.find(({ url }) => url === plan.latestMac.path);
  const lines = [`version: ${plan.latestMac.version}`, "files:"];
  for (const file of files) {
    lines.push(
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    );
  }
  lines.push(`path: ${primary.url}`, `sha512: ${primary.sha512}`);
  lines.push(`releaseDate: '${new Date().toISOString()}'`);
  return `${lines.join("\n")}\n`;
}

async function readRecords(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const text = await readFile(path.join(dir, entry.name), "utf8");
    let record;
    try {
      record = JSON.parse(text);
    } catch (error) {
      throw new Error(`Record ${entry.name}: ${error instanceof Error ? error.message : error}`, { cause: error });
    }
    records.push({ name: entry.name, record });
  }
  return records;
}

export async function runCli(argv) {
  const { dir, outDir, recordsDir, target } = parseArguments(argv);
  const entries = await readdir(dir, { withFileTypes: true });
  const hostArchive = new RegExp(`^omp-ui-host-.+\\.${escapeRegExp(HOST_ARCHIVE_EXT[target.platform] ?? "")}$`);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const file = path.join(dir, entry.name);
        const { size } = await stat(file);
        // Only host archives are tied to a record by hash; hashing the DMGs here would be wasted work.
        const sha256 = hostArchive.test(entry.name) ? await digest(file, "sha256", "hex") : undefined;
        return { name: entry.name, size, ...(sha256 !== undefined ? { sha256 } : {}) };
      }),
  );
  const plan = planReleaseManifest(files, target, await readRecords(recordsDir));

  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "checksum-inputs.txt"),
    `${plan.checksumInputs.join("\n")}\n`,
  );
  if (plan.latestMac) {
    await writeFile(
      path.join(outDir, "latest-mac.yml"),
      await renderLatestMac(plan, dir),
    );
  }
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  return plan;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
